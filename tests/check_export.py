"""Open the files written by tests/test_export.mjs with GDAL (rasterio) and pyshp and check them."""
import json, zipfile, io, sys, os
import numpy as np, rasterio, shapefile
truth = json.load(open(os.path.join(os.path.dirname(__file__), "fixtures/sample-truth.json")))
ok = True
for t in ("affine", "poly2"):
    with rasterio.open(f"/tmp/amano-{t}.tif") as ds:
        print(t, ds.width, ds.height, ds.count, ds.crs, "res", ds.res, "bounds", [round(v, 1) for v in ds.bounds])
        assert ds.crs.to_epsg() == 20935, ds.crs
        assert ds.count == 4 and ds.colorinterp[3].name == "alpha", ds.colorinterp
        a = ds.read()
        # 1. frame corner pixels should be dark (the neatline) at the true corner coordinates
        E0, N0, E1, N1 = truth["extent"]
        errs = []
        # 2. grid intersections: find the darkest spot within +-6 px of each true intersection
        for e in range(E0 + 1000, E1, 1000):
            for n in range(N0 + 1000, N1, 1000):
                cf, rf = ~ds.transform * (e, n)          # exact (fractional) pixel position
                r, c = int(rf), int(cf)
                win = 255 * 3 - a[:3, r - 8:r + 9, c - 8:c + 9].astype(float).sum(0)   # darkness
                # sample the line away from the crossing itself, then take the darkness-weighted centre
                colprof = win[:3].sum(0) + win[-3:].sum(0); rowprof = win[:, :3].sum(1) + win[:, -3:].sum(1)
                colprof -= np.median(colprof); rowprof -= np.median(rowprof)
                colprof[colprof < colprof.max() * 0.3] = 0; rowprof[rowprof < rowprof.max() * 0.3] = 0
                idx = np.arange(17)
                cc = (colprof * idx).sum() / colprof.sum() + (c - 8) + 0.5
                rr = (rowprof * idx).sum() / rowprof.sum() + (r - 8) + 0.5
                errs.append((cc - cf, rr - rf))
        errs = np.array(errs)
        ae = np.abs(errs).max(1)
        p90 = float(np.percentile(ae, 90))
        # a few crossings sit on geological contacts or labels, which disturb this simple measurement
        print("   grid intersections in output: mean offset px", errs.mean(0).round(2), "median", round(float(np.median(ae)), 2), "p90", round(p90, 2), "over 1px:", int((ae > 1).sum()), "of", len(ae))
        if p90 > 0.75 or np.abs(errs.mean(0)).max() > 0.4: ok = False
        alpha = a[3]
        print("   transparent collar fraction", round(float((alpha == 0).mean()), 4))
z = zipfile.ZipFile("/tmp/amano-vectors.zip")
print(z.namelist()); assert z.testzip() is None
for name, n in (("polygons", 1), ("points", 5), ("lines", 1)):
    r = shapefile.Reader(shp=io.BytesIO(z.read(name + ".shp")), shx=io.BytesIO(z.read(name + ".shx")), dbf=io.BytesIO(z.read(name + ".dbf")), encoding="utf-8")
    print(name, r.shapeTypeName, len(r), [f[0] for f in r.fields[1:]], r.record(0).as_dict(), [round(v, 1) for v in r.bbox])
    assert len(r) == n
    if name == "polygons":
        s = r.shape(0); print("   parts", list(s.parts), "points", len(s.points))
        import shapefile as sf
        assert abs(sf.signed_area(s.points[:5])) == 4e6 and sf.signed_area(s.points[:5]) < 0, "outline must be clockwise"
gj = json.loads(z.read("features.geojson")); print("geojson features", len(gj["features"]))
print("ALL OK" if ok else "FAILED"); sys.exit(0 if ok else 1)
