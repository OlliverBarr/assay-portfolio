// Vanilla ES module, no build step, no framework. Chart.js is loaded as a
// global (see the UMD <script> tag in index.html) so it's referenced here
// as the ambient `Chart` binding.
//
// XSS rule: every string that ultimately came from the database (token
// name/symbol, alert level, etc.) is adversarial input. All DOM containing
// such values is built with document.createElement + textContent. This
// file must never pass an interpolated string to innerHTML.

const FEATURE_KEYS = [
  "quoteLiquidityUsd",
  "totalLiquidityUsd",
  "ageMinutesAtEntry",
  "uniqueBuyers1h",
  "buySizeGiniBps",
  "buySizeEntropyBps",
  "repeatedSizeBuyPctBps",
  "floatBps",
  "supplyInPoolBps",
  "adjustedTop10PctBps",
  "deployerPctBps",
  "adjustedHolderCount",
  "effectiveSellLossBps"
];

const COLOR = {
  red: "#ef4444",
  yellow: "#eab308",
  green: "#22c55e",
  accent: "#60a5fa",
  accent2: "#a78bfa",
  muted: "#8b93a7"
};

const CHART_DEFAULTS = {
  color: COLOR.muted,
  borderColor: "#262b38"
};

const charts = {};

function renderChart(canvasId, config) {
  if (charts[canvasId]) {
    charts[canvasId].destroy();
  }
  const canvas = document.getElementById(canvasId);
  charts[canvasId] = new Chart(canvas, config);
}

function setStatus(panelId, message, isError) {
  const el = document.getElementById(`status-${panelId}`);
  if (el === null) return;
  el.textContent = message;
  el.hidden = message.length === 0;
  el.classList.toggle("is-error", isError === true);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body !== null && typeof body === "object" && typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // response body wasn't JSON; keep the status-based message
    }
    throw new Error(message);
  }
  return res.json();
}

// ---- Panel 1: funnel ----

async function loadFunnel() {
  try {
    const data = await fetchJson("/api/funnel");
    if (data.pools === 0) {
      setStatus("funnel", "no data yet: run the worker", false);
      renderChart("chart-funnel", { type: "bar", data: { labels: [], datasets: [] } });
      return;
    }
    setStatus("funnel", "", false);
    renderChart("chart-funnel", {
      type: "bar",
      data: {
        labels: [
          "Pools",
          "Trusted-quote pools",
          "Band entrants",
          "Eligible tokens",
          "Alerted RED",
          "Alerted YELLOW",
          "Alerted GREEN"
        ],
        datasets: [
          {
            label: "count",
            data: [
              data.pools,
              data.trustedQuotePools,
              data.bandEntrantPools,
              data.eligibleTokens,
              data.alertedTokens.RED,
              data.alertedTokens.YELLOW,
              data.alertedTokens.GREEN
            ],
            backgroundColor: [
              COLOR.accent,
              COLOR.accent,
              COLOR.accent,
              COLOR.accent2,
              COLOR.red,
              COLOR.yellow,
              COLOR.green
            ]
          }
        ]
      },
      options: {
        indexAxis: "y",
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true } }
      }
    });
  } catch (error) {
    setStatus("funnel", `failed to load: ${error.message}`, true);
  }
}

// ---- Panel 2: launch cadence ----

async function loadCadence() {
  try {
    const points = await fetchJson("/api/launches?days=30");
    if (points.length === 0) {
      setStatus("cadence", "no data yet: run the worker", false);
      renderChart("chart-cadence", { type: "line", data: { labels: [], datasets: [] } });
      return;
    }
    setStatus("cadence", "", false);
    renderChart("chart-cadence", {
      type: "line",
      data: {
        labels: points.map((p) => p.day),
        datasets: [
          {
            label: "pools/day",
            data: points.map((p) => p.pools),
            borderColor: COLOR.accent,
            backgroundColor: COLOR.accent,
            tension: 0.2
          },
          {
            label: "trusted-quote pools/day",
            data: points.map((p) => p.trustedQuotePools),
            borderColor: COLOR.green,
            backgroundColor: COLOR.green,
            tension: 0.2
          }
        ]
      },
      options: { scales: { y: { beginAtZero: true } } }
    });
  } catch (error) {
    setStatus("cadence", `failed to load: ${error.message}`, true);
  }
}

// ---- Panel 3: score precision ----

async function loadPrecision() {
  try {
    const curve = await fetchJson("/api/precision?horizon=72");
    if (curve.scored + curve.unscored === 0) {
      setStatus("precision", "no data yet: run the worker", false);
      renderChart("chart-precision", { type: "line", data: { labels: [], datasets: [] } });
      return;
    }
    if (curve.scored === 0) {
      setStatus(
        "precision",
        `${curve.unscored} band entrants, none with a score known within 15min of entry yet`,
        false
      );
      renderChart("chart-precision", { type: "line", data: { labels: [], datasets: [] } });
      return;
    }
    setStatus("precision", "", false);
    const nByFloor = curve.points.map((p) => p.n);
    renderChart("chart-precision", {
      type: "line",
      data: {
        labels: curve.points.map((p) => `≥${p.floor}`),
        datasets: [
          {
            label: "share ≥2x",
            data: curve.points.map((p) => p.share2x),
            borderColor: COLOR.accent,
            backgroundColor: COLOR.accent
          },
          {
            label: "share ≥5x",
            data: curve.points.map((p) => p.share5x),
            borderColor: COLOR.yellow,
            backgroundColor: COLOR.yellow
          },
          {
            label: "share ≥10x",
            data: curve.points.map((p) => p.share10x),
            borderColor: COLOR.green,
            backgroundColor: COLOR.green
          }
        ]
      },
      options: {
        scales: { y: { beginAtZero: true, max: 1 } },
        plugins: {
          tooltip: {
            callbacks: {
              afterLabel: (context) => `n=${nByFloor[context.dataIndex]}`
            }
          }
        }
      }
    });
  } catch (error) {
    setStatus("precision", `failed to load: ${error.message}`, true);
  }
}

// ---- Panel 4: feature quartiles ----

function initFeatureSelect() {
  const select = document.getElementById("quartile-feature");
  for (const key of FEATURE_KEYS) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key;
    select.appendChild(option);
  }
  select.value = FEATURE_KEYS[0];
  select.addEventListener("change", () => {
    void loadQuartiles(select.value);
  });
  return select;
}

async function loadQuartiles(feature) {
  try {
    const data = await fetchJson(
      `/api/quartiles?feature=${encodeURIComponent(feature)}&horizon=72`
    );
    const totalRows = data.nullRows + data.buckets.reduce((sum, b) => sum + b.n, 0);
    if (totalRows === 0) {
      setStatus("quartiles", "no data yet: run the worker", false);
      renderChart("chart-quartiles", { type: "bar", data: { labels: [], datasets: [] } });
      return;
    }
    if (data.buckets.length === 0) {
      setStatus(
        "quartiles",
        `no numeric rows for "${feature}" yet (${data.nullRows} rows null/non-numeric)`,
        false
      );
      renderChart("chart-quartiles", { type: "bar", data: { labels: [], datasets: [] } });
      return;
    }
    setStatus("quartiles", "", false);
    const nByBucket = data.buckets.map((b) => b.n);
    renderChart("chart-quartiles", {
      type: "bar",
      data: {
        labels: data.buckets.map((b) => `Q${b.bucket}`),
        datasets: [
          {
            label: "median 72h multiple (bps)",
            data: data.buckets.map((b) => b.medianMultipleBps),
            backgroundColor: COLOR.accent2
          }
        ]
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterLabel: (context) => `n=${nByBucket[context.dataIndex]}`
            }
          }
        },
        scales: { y: { beginAtZero: true } }
      }
    });
  } catch (error) {
    setStatus("quartiles", `failed to load: ${error.message}`, true);
  }
}

// ---- Panel 5: survival ----

async function loadSurvival() {
  try {
    const points = await fetchJson("/api/survival");
    if (points.length === 0) {
      setStatus("survival", "no data yet: run the worker", false);
      renderChart("chart-survival", { type: "bar", data: { labels: [], datasets: [] } });
      return;
    }
    setStatus("survival", "", false);
    renderChart("chart-survival", {
      type: "bar",
      data: {
        labels: points.map((p) => `${p.horizonHours}h`),
        datasets: [
          {
            label: "SURVIVED",
            data: points.map((p) => p.survived),
            backgroundColor: COLOR.green
          },
          {
            label: "DIED",
            data: points.map((p) => p.died),
            backgroundColor: COLOR.red
          }
        ]
      },
      options: { scales: { y: { beginAtZero: true } } }
    });
  } catch (error) {
    setStatus("survival", `failed to load: ${error.message}`, true);
  }
}

// ---- Panel 6: recent alerts ----

function levelDot(level) {
  const dot = document.createElement("span");
  const cls =
    level === "RED" ? "dot-red" : level === "YELLOW" ? "dot-yellow" : "dot-green";
  dot.className = `dot ${cls}`;
  return dot;
}

function multipleCell(maxMultipleBps) {
  const cell = document.createElement("td");
  if (maxMultipleBps === null) {
    cell.textContent = "unlabeled";
    cell.className = "multiple-unlabeled";
    return cell;
  }
  const multiple = maxMultipleBps / 10_000;
  cell.textContent = `${multiple.toFixed(2)}x`;
  cell.className = maxMultipleBps >= 20_000 ? "multiple-up" : maxMultipleBps < 10_000 ? "multiple-down" : "";
  return cell;
}

function alertRowElement(row) {
  const tr = document.createElement("tr");

  const timeCell = document.createElement("td");
  timeCell.textContent = row.sentAt;
  tr.appendChild(timeCell);

  const levelCell = document.createElement("td");
  levelCell.appendChild(levelDot(row.alertLevel));
  levelCell.appendChild(document.createTextNode(row.alertLevel));
  tr.appendChild(levelCell);

  const scoreCell = document.createElement("td");
  scoreCell.textContent = String(row.score);
  tr.appendChild(scoreCell);

  const tokenCell = document.createElement("td");
  const name = row.name === null ? row.tokenAddress : row.name;
  const symbol = row.symbol === null ? "" : ` (${row.symbol})`;
  tokenCell.textContent = `${name}${symbol}`;
  tr.appendChild(tokenCell);

  const deliveredCell = document.createElement("td");
  deliveredCell.textContent = row.delivered ? "yes" : "no";
  tr.appendChild(deliveredCell);

  tr.appendChild(multipleCell(row.maxMultipleBps));

  return tr;
}

async function loadAlerts() {
  try {
    const rows = await fetchJson("/api/alerts?limit=50");
    const tbody = document.getElementById("table-alerts-body");
    while (tbody.firstChild !== null) tbody.removeChild(tbody.firstChild);
    if (rows.length === 0) {
      setStatus("alerts", "no data yet: run the worker", false);
      return;
    }
    setStatus("alerts", "", false);
    for (const row of rows) {
      tbody.appendChild(alertRowElement(row));
    }
  } catch (error) {
    setStatus("alerts", `failed to load: ${error.message}`, true);
  }
}

// ---- Panel 7: judgment quality ----

async function loadJudgment() {
  try {
    const data = await fetchJson("/api/judgment");
    if (data.versions.length === 0 && data.weekly.length === 0) {
      setStatus("judgment", "no data yet: run the worker", false);
      renderChart("chart-judgment-versions", { type: "bar", data: { labels: [], datasets: [] } });
      renderChart("chart-judgment-weekly", { type: "bar", data: { labels: [], datasets: [] } });
      return;
    }
    setStatus("judgment", "", false);
    renderChart("chart-judgment-versions", {
      type: "bar",
      data: {
        labels: data.versions.map((v) => `v${v.promptVersion}`),
        datasets: [
          {
            label: "completed",
            data: data.versions.map((v) => v.completed),
            backgroundColor: COLOR.green
          },
          {
            label: "rejected (fabricated)",
            data: data.versions.map((v) => v.rejectedFabricated),
            backgroundColor: COLOR.yellow
          },
          {
            label: "failed",
            data: data.versions.map((v) => v.failed),
            backgroundColor: COLOR.red
          }
        ]
      },
      options: {
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }
      }
    });
    renderChart("chart-judgment-weekly", {
      type: "bar",
      data: {
        labels: data.weekly.map((w) => w.week),
        datasets: [
          {
            label: "completed",
            data: data.weekly.map((w) => w.completed),
            backgroundColor: COLOR.green
          },
          {
            label: "rejected (fabricated)",
            data: data.weekly.map((w) => w.rejectedFabricated),
            backgroundColor: COLOR.yellow
          },
          {
            label: "failed",
            data: data.weekly.map((w) => w.failed),
            backgroundColor: COLOR.red
          }
        ]
      },
      options: {
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } }
      }
    });
  } catch (error) {
    setStatus("judgment", `failed to load: ${error.message}`, true);
  }
}

// ---- init ----

if (typeof Chart !== "undefined" && Chart.defaults) {
  Chart.defaults.color = CHART_DEFAULTS.color;
  Chart.defaults.borderColor = CHART_DEFAULTS.borderColor;
}

const featureSelect = initFeatureSelect();

void loadFunnel();
void loadCadence();
void loadPrecision();
void loadQuartiles(featureSelect.value);
void loadSurvival();
void loadAlerts();
void loadJudgment();
