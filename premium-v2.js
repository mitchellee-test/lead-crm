
/* Pipeline progress bars — visual only */
(() => {
  function mount() {
    const panel = document.getElementById("stageBreakdown");
    if (!panel) return;

    function updateBars() {
      const rows = [...panel.querySelectorAll(".row")];
      const counts = rows.map(row =>
        Math.max(0, Number(row.querySelector("b")?.textContent) || 0)
      );
      const total = counts.reduce((sum, n) => sum + n, 0);

      rows.forEach((row, i) => {
        const percent = total ? (counts[i] / total) * 100 : 0;
        row.style.setProperty("--stage-fill", percent + "%");
      });
    }

    new MutationObserver(updateBars).observe(
      panel, { childList: true }
    );

    updateBars();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
