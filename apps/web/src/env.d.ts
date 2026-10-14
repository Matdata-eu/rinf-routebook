/// <reference types="vite/client" />

// optional aerial imagery settings, see apps/web/.env.example
interface ImportMetaEnv {
  readonly VITE_ESRI_API_KEY?: string;
  readonly VITE_AERIAL_TILES?: string;
  readonly VITE_AERIAL_LABEL?: string;
  readonly VITE_AERIAL_ATTRIBUTION?: string;
  readonly VITE_AERIAL_MAXZOOM?: string;
  readonly VITE_AERIAL_TILESIZE?: string;
}
