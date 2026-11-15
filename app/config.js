// Amano Georeferencer — site configuration.
// Set proxyUrl to the address of the Amano AI server (see /proxy/README.md) so visitors can use
// the AI steps without their own API key. Leave it empty to ask each user for their own key.
// Never put an API key in this file: everything here is public.
window.AMANO_CONFIG = {
  proxyUrl: '',

  // Accounts and history (see /backend/README.md). Leave both empty to run without sign-in.
  // Use the anon / publishable key only: never the service_role key.
  supabaseUrl: '',
  supabaseAnonKey: '',
};
