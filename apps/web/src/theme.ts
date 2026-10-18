/**
 * Light and dark theme (MatData design system). The page follows the system setting
 * until the user picks one with the header button; the choice is kept in localStorage.
 * index.html sets data-theme before the first paint, so there is no flash.
 */
import type { RasterLayerSpecification } from "maplibre-gl";

export type Theme = "light" | "dark";

const KEY = "routebook-theme";

function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function systemTheme(): Theme {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The stored choice, or the system setting when there is none. */
export function preferredTheme(): Theme {
  const saved = storage()?.getItem(KEY);
  return saved === "dark" || saved === "light" ? saved : systemTheme();
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

const listeners = new Set<(t: Theme) => void>();

/** Called with the new theme whenever it changes. */
export function onThemeChange(fn: (t: Theme) => void): void {
  listeners.add(fn);
}

export function setTheme(t: Theme, remember = true): void {
  document.documentElement.dataset.theme = t;
  if (remember) {
    try {
      storage()?.setItem(KEY, t);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
  }
  for (const fn of listeners) fn(t);
}

/** Follow the system setting while the user has not picked a theme. */
export function followSystemTheme(): void {
  if (typeof matchMedia !== "function") return;
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!storage()?.getItem(KEY)) setTheme(systemTheme(), false);
  });
}

/** Colours of the map layers per theme: the design system tokens, as MapLibre needs literal values. */
export const MAP_COLORS = {
  light: {
    bg: "#edf0f4", network: "#56606c", networkOnImagery: "#f2f4f6", casing: "#ffffff", route: "#0563bb",
    station: "#1c2633", op: "#808893", unroutable: "#b4bac2", label: "#1c2633", halo: "#ffffff", from: "#0563bb", to: "#1c2633",
    selected: "rgba(242,179,0,0.35)", selectedRing: "#f2b300", travelled: "#808893",
    driveGround: "#e3e8df", driveTracks: "#7c8a97", sky: "#9fc5e8", horizon: "#e8f1f8",
  },
  dark: {
    bg: "#0a1016", network: "#a3afba", networkOnImagery: "#eef1ef", casing: "#0d141c", route: "#5aa8f2",
    station: "#eef1ef", op: "#6f7e8c", unroutable: "#4a5561", label: "#eef1ef", halo: "#0d141c", from: "#5aa8f2", to: "#eef1ef",
    selected: "rgba(245,194,66,0.3)", selectedRing: "#f5c242", travelled: "#6f7e8c",
    driveGround: "#151c17", driveTracks: "#6f7e8c", sky: "#0d141c", horizon: "#26323e",
  },
} as const;

export type MapColors = (typeof MAP_COLORS)[Theme];

export function mapColors(t: Theme = currentTheme()): MapColors {
  return MAP_COLORS[t];
}

/**
 * Raster paint for a background in the given theme. Dark mode dims a street map and takes some
 * colour out, as RINF Atlas does, and dims imagery a little; light mode keeps `paint`.
 */
export function themedRasterPaint(paint: RasterLayerSpecification["paint"], aerial: boolean, t: Theme): NonNullable<RasterLayerSpecification["paint"]> {
  const base = { "raster-brightness-min": 0, "raster-brightness-max": 1, "raster-contrast": 0, ...paint };
  if (t === "light") return base;
  if (aerial) return { ...base, "raster-brightness-max": Math.min(0.7, Number(base["raster-brightness-max"] ?? 1)) };
  return { ...base, "raster-brightness-max": 0.72, "raster-saturation": -0.5, "raster-contrast": 0.1 };
}
