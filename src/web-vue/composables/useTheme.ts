import { ref } from "vue";

type Theme = "light" | "dark";
const STORAGE_KEY = "soloist-theme";

function stored(): Theme | null {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === "dark" || t === "light" ? t : null;
  } catch {
    return null; // private mode
  }
}

// Committed light unless the user has opted into dark (DESIGN.md). The <head> inline
// script applies the stored value pre-paint to avoid FOUC; this mirrors it reactively.
const theme = ref<Theme>((document.documentElement.dataset.theme as Theme) || stored() || "light");
document.documentElement.dataset.theme = theme.value;

export function useTheme() {
  function toggle() {
    theme.value = theme.value === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme.value;
    try {
      localStorage.setItem(STORAGE_KEY, theme.value);
    } catch {
      /* private mode — session-only theme */
    }
  }
  return { theme, toggle };
}
