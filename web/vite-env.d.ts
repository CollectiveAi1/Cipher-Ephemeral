/** Build-time configuration injected by Vite. */
interface ImportMetaEnv {
  readonly VITE_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
