/* Theme bootstrap: a classic external script so the CSP needs no inline script.
   Applies the persisted theme (or the OS preference) before first paint. */
(function () {
  var KEY = "omp-console.theme";
  var stored = null;
  try {
    stored = window.localStorage.getItem(KEY);
  } catch (error) {
    stored = null;
  }
  var theme =
    stored === "light" || stored === "dark"
      ? stored
      : window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = theme;
})();
