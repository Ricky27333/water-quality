/**
 * Smart Shrimp Farming System - Single Page Dashboard Application Logic
 */

// Application State
const appState = {
  activeTab: 'dashboard',
  current: {
    dissolvedOxygen: 6.2,
    pH: 7.8,
    salinity: 18.5,
    temperature: 28.4,
    ammonia: 0.04,
    hardness: 195.0,
    timestamp: Date.now()
  },
  history: [],
  control: {
    oxygenTurbine: 'AUTO',
    waterTurbine: 'AUTO',
    oxygenTurbineActive: false,
    waterTurbineActive: false,
    aerator: 'AUTO',
    waterPump: 'AUTO',
    aeratorActive: false,
    waterPumpActive: false,
    lastChanged: Date.now()
  },
  settings: {
    dissolvedOxygen: { min: 4.0, max: 8.0, unit: "mg/L", label: "Dissolved Oxygen" },
    pH: { min: 7.5, max: 8.5, unit: "", label: "pH Level" },
    salinity: { min: 10.0, max: 25.0, unit: "ppt", label: "Salinity" },
    temperature: { min: 26.0, max: 32.0, unit: "°C", label: "Temperature" },
    ammonia: { min: 0.0, max: 0.1, unit: "mg/L", label: "Ammonia (TAN)" },
    hardness: { min: 100.0, max: 300.0, unit: "mg/L", label: "Total Hardness" }
  },
  alerts: [],
  alertFilter: 'all',
  timeRange: '24h',
  trendParam: 'dissolvedOxygen',
  isStale: false,
  chartInstance: null
};

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', async () => {
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  // Start real-time clock
  startClock();

  // Load initial data from server
  await fetchAllPondData();

  // Setup periodic refresh & stale watchdog
  setInterval(checkStaleAndTick, 1000);
  setInterval(fetchPondCurrent, 1000); // Ultra-fast live sync from ESP32 API (1s latency!)

  // Initialize Trend Chart
  initTrendChart();
});

// --- CLOCK & TIMING WATCHDOG ---
function startClock() {
  const clockEl = document.getElementById('current-clock');
  const update = () => {
    const now = new Date();
    if (clockEl) {
      clockEl.textContent = now.toLocaleTimeString();
    }
  };
  update();
  setInterval(update, 1000);
}

function checkStaleAndTick() {
  const now = Date.now();
  const lastTs = appState.current.timestamp || now;
  const elapsedMs = now - lastTs;
  const elapsedSec = Math.floor(elapsedMs / 1000);

  // Watchdog timeout is 20s (or when isOnline is explicitly false)
  const isHardwareOffline = (appState.isOnline === false) || (elapsedSec > 20);
  appState.isStale = isHardwareOffline;

  const staleBanner = document.getElementById('stale-banner');
  const lastUpdatedEl = document.getElementById('last-updated-text');
  const espStatusText = document.getElementById('esp-status-text');
  const connPill = document.getElementById('connection-status-pill');
  const connDot = document.getElementById('connection-dot');
  const connText = document.getElementById('connection-text');
  const hwToggleBtnText = document.getElementById('hw-toggle-btn-text');
  const hwToggleIcon = document.getElementById('hw-toggle-icon');

  if (lastUpdatedEl) {
    if (elapsedSec < 5) {
      lastUpdatedEl.textContent = 'Just now';
    } else if (elapsedSec < 60) {
      lastUpdatedEl.textContent = `${elapsedSec}s ago`;
    } else {
      const mins = Math.floor(elapsedSec / 60);
      lastUpdatedEl.textContent = `${mins}m ${elapsedSec % 60}s ago`;
    }
  }

  if (isHardwareOffline) {
    if (staleBanner) staleBanner.classList.remove('hidden');
    if (espStatusText) {
      espStatusText.textContent = 'OFFLINE (000)';
      espStatusText.className = 'font-mono text-rose-400 text-[11px] font-bold animate-pulse';
    }
    if (connPill && connDot && connText) {
      connPill.className = 'flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30';
      connDot.className = 'w-2 h-2 rounded-full bg-rose-500 animate-ping';
      connText.textContent = 'ESP32 OFFLINE';
    }
    if (hwToggleBtnText) {
      hwToggleBtnText.textContent = 'Reconnect ESP32';
    }
    if (hwToggleIcon) {
      hwToggleIcon.className = 'w-3.5 h-3.5 text-emerald-400';
    }
  } else {
    if (staleBanner) staleBanner.classList.add('hidden');
    if (espStatusText) {
      espStatusText.textContent = 'Synced';
      espStatusText.className = 'font-mono text-emerald-400 text-[11px]';
    }
    if (connPill && connDot && connText) {
      connPill.className = 'flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30';
      connDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
      connText.textContent = 'ESP32 Synced';
    }
    if (hwToggleBtnText) {
      hwToggleBtnText.textContent = 'Test Disconnect (000)';
    }
    if (hwToggleIcon) {
      hwToggleIcon.className = 'w-3.5 h-3.5 text-rose-400';
    }
  }
}

function dismissStaleBanner() {
  const staleBanner = document.getElementById('stale-banner');
  if (staleBanner) staleBanner.classList.add('hidden');
}

// --- DATA FETCHING & REALTIME LISTENERS ---
async function fetchAllPondData() {
  try {
    const res = await fetch('/api/pond/all');
    if (!res.ok) throw new Error('Failed to load pond data');
    const data = await res.json();

    appState.isOnline = data.isOnline !== undefined ? data.isOnline : true;
    appState.systemStatus = data.systemStatus || 'ONLINE';
    if (data.current) appState.current = data.current;
    if (data.control) appState.control = data.control;
    if (data.settings) appState.settings = data.settings;
    if (data.alerts) appState.alerts = data.alerts;

    // Populate Settings UI
    populateSettingsInputs();
    populateConfigInputs(data.config);

    // Update UI components
    updateLiveDashboard();
    updateControlUI();
    renderAlertsTable();
    await fetchHistoricalData(appState.timeRange);

  } catch (err) {
    console.error('Error in fetchAllPondData:', err);
    appState.isOnline = false;
    updateLiveDashboard();
  }
}

async function fetchPondCurrent() {
  try {
    const res = await fetch('/api/sensors');
    if (!res.ok) return;
    const json = await res.json();
    appState.isOnline = json.isOnline !== undefined ? json.isOnline : true;
    appState.systemStatus = json.systemStatus || 'ONLINE';
    if (json.flatValues) {
      appState.current = {
        ...appState.current,
        ...json.flatValues,
        timestamp: json.timestamp || Date.now()
      };
    }
    if (json.actuators) {
      if (json.actuators.oxygenTurbine) {
        appState.control.oxygenTurbine = json.actuators.oxygenTurbine.mode;
        appState.control.oxygenTurbineActive = json.actuators.oxygenTurbine.active;
        appState.control.aerator = json.actuators.oxygenTurbine.mode;
        appState.control.aeratorActive = json.actuators.oxygenTurbine.active;
      }
      if (json.actuators.waterTurbine) {
        appState.control.waterTurbine = json.actuators.waterTurbine.mode;
        appState.control.waterTurbineActive = json.actuators.waterTurbine.active;
        appState.control.waterPump = json.actuators.waterTurbine.mode;
        appState.control.waterPumpActive = json.actuators.waterTurbine.active;
      }
    }
    updateLiveDashboard();
    updateControlUI();
  } catch (e) {
    // If backend unreachable, mark offline
    appState.isOnline = false;
    updateLiveDashboard();
  }
}

function setupRealtimeListeners() {
  // Direct HTTP polling active via fetchPondCurrent()
}

// --- TAB NAVIGATION ---
function switchTab(tabId) {
  playSound('click');
  appState.activeTab = tabId;

  const tabs = ['dashboard', 'trends', 'control', 'alerts', 'settings'];
  const titles = {
    dashboard: 'Live Dashboard',
    trends: 'Historical Trends',
    control: 'Device Control Panel',
    alerts: 'Alerts & Incidents',
    settings: 'Settings & Limits'
  };

  tabs.forEach(t => {
    const section = document.getElementById(`tab-${t}`);
    const btn = document.getElementById(`tab-btn-${t}`);
    if (section) {
      if (t === tabId) {
        section.classList.remove('hidden');
      } else {
        section.classList.add('hidden');
      }
    }
    if (btn) {
      if (t === tabId) {
        btn.className = 'nav-btn active w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 shadow-sm';
      } else {
        btn.className = 'nav-btn w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 text-slate-400 hover:text-slate-200 hover:bg-slate-800/50';
      }
    }
  });

  const pageTitleEl = document.getElementById('page-title');
  if (pageTitleEl) pageTitleEl.textContent = titles[tabId] || 'Dashboard';

  // If switched to trends tab, trigger chart resize/redraw
  if (tabId === 'trends' && appState.chartInstance) {
    setTimeout(() => {
      appState.chartInstance.windowResizeHandler();
    }, 150);
  }

  // If switched to dashboard, ensure canvas simulation bounds are crisp
  if (tabId === 'dashboard' && window.shrimpSimInstance) {
    setTimeout(() => {
      window.shrimpSimInstance.resize();
    }, 100);
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// --- LIVE DASHBOARD MODULE ---
function updateLiveDashboard() {
  const current = appState.current;
  const settings = appState.settings;
  const isOnline = (appState.isOnline !== undefined) ? appState.isOnline : !appState.isStale;

  let optimalCount = 0;
  let warningCount = 0;
  let criticalCount = 0;

  const parameters = [
    { key: 'dissolvedOxygen', valId: 'val-do', badgeId: 'badge-do', rangeId: 'range-do', gaugeId: 'gauge-do', trendId: 'trend-do' },
    { key: 'pH', valId: 'val-ph', badgeId: 'badge-ph', rangeId: 'range-ph', gaugeId: 'gauge-ph', trendId: 'trend-ph' },
    { key: 'salinity', valId: 'val-salinity', badgeId: 'badge-salinity', rangeId: 'range-salinity', gaugeId: 'gauge-salinity', trendId: 'trend-salinity' },
    { key: 'temperature', valId: 'val-temperature', badgeId: 'badge-temperature', rangeId: 'range-temperature', gaugeId: 'gauge-temperature', trendId: 'trend-temperature' },
    { key: 'ammonia', valId: 'val-ammonia', badgeId: 'badge-ammonia', rangeId: 'range-ammonia', gaugeId: 'gauge-ammonia', trendId: 'trend-ammonia' },
    { key: 'hardness', valId: 'val-hardness', badgeId: 'badge-hardness', rangeId: 'range-hardness', gaugeId: 'gauge-hardness', trendId: 'trend-hardness' }
  ];

  parameters.forEach(p => {
    const rawVal = current[p.key];
    const val = (rawVal !== undefined && rawVal !== null) ? Number(rawVal) : 0;
    const thresh = settings[p.key] || { min: 0, max: 100 };
    const pMin = thresh.min;
    const pMax = thresh.max;
    const unit = thresh.unit || '';

    // Value Element - When offline, explicitly display "000" as required
    const valEl = document.getElementById(p.valId);
    if (valEl) {
      if (!isOnline) {
        valEl.textContent = '000';
      } else {
        if (p.key === 'ammonia') valEl.textContent = val.toFixed(3);
        else if (p.key === 'hardness') valEl.textContent = Math.round(val);
        else valEl.textContent = val.toFixed(1);
      }
    }

    // Range Label
    const rangeEl = document.getElementById(p.rangeId);
    if (rangeEl) {
      if (p.key === 'ammonia') rangeEl.textContent = `< ${pMax} ${unit}`;
      else rangeEl.textContent = `${pMin} - ${pMax} ${unit}`;
    }

    // Determine status: Normal vs Warning vs Critical vs OFFLINE
    let status = 'normal';
    if (!isOnline) {
      status = 'offline';
    } else if (val < pMin) {
      const deficit = (pMin - val) / (pMin || 1);
      status = deficit > 0.2 ? 'critical' : 'warning';
    } else if (val > pMax) {
      const excess = (val - pMax) / (pMax || 1);
      status = excess > 0.2 ? 'critical' : 'warning';
    }

    if (isOnline) {
      if (status === 'normal') optimalCount++;
      else if (status === 'warning') warningCount++;
      else if (status === 'critical') criticalCount++;
    }

    // Badge Element
    const badgeEl = document.getElementById(p.badgeId);
    if (badgeEl) {
      if (!isOnline) {
        badgeEl.textContent = 'SYSTEM OFFLINE';
        badgeEl.className = 'text-xs font-semibold px-2.5 py-0.5 rounded-full badge-critical animate-pulse';
      } else {
        badgeEl.textContent = status.toUpperCase();
        badgeEl.className = `text-xs font-semibold px-2.5 py-0.5 rounded-full badge-${status}`;
      }
    }

    // Gauge Bar Progress Percentage
    const gaugeEl = document.getElementById(p.gaugeId);
    if (gaugeEl) {
      if (!isOnline) {
        gaugeEl.style.width = '0%';
        gaugeEl.className = 'gauge-bar-fill bg-slate-700 h-full rounded-full';
      } else {
        let pct = 50;
        if (p.key === 'ammonia') {
          pct = Math.min(100, Math.max(5, (val / (pMax * 2)) * 100));
        } else {
          const spread = (pMax - pMin) * 1.5;
          const lowBound = pMin - ((pMax - pMin) * 0.25);
          pct = Math.min(100, Math.max(5, ((val - lowBound) / spread) * 100));
        }
        gaugeEl.style.width = `${pct}%`;

        if (status === 'normal') {
          gaugeEl.className = 'gauge-bar-fill bg-emerald-400 h-full rounded-full';
        } else if (status === 'warning') {
          gaugeEl.className = 'gauge-bar-fill bg-amber-400 h-full rounded-full';
        } else {
          gaugeEl.className = 'gauge-bar-fill bg-rose-500 h-full rounded-full';
        }
      }
    }
  });

  // Overall Pond Health Score Calculation (0 - 100%)
  const healthScore = !isOnline ? 0 : Math.max(10, Math.round(100 - (warningCount * 12) - (criticalCount * 30)));
  const healthScoreEl = document.getElementById('health-score-val');
  const healthBadgeEl = document.getElementById('health-status-badge');
  const healthDescEl = document.getElementById('health-description');
  const healthCircleEl = document.getElementById('health-circle');

  if (healthScoreEl) healthScoreEl.textContent = !isOnline ? '000%' : `${healthScore}%`;

  if (healthCircleEl) {
    if (!isOnline) {
      healthCircleEl.style.strokeDashoffset = 175.9; // 0%
      healthCircleEl.setAttribute('class', 'text-rose-500 transition-all duration-700');
    } else {
      const offset = 175.9 - (175.9 * (healthScore / 100));
      healthCircleEl.style.strokeDashoffset = offset;
      if (healthScore >= 80) {
        healthCircleEl.setAttribute('class', 'text-emerald-400 transition-all duration-700');
      } else if (healthScore >= 50) {
        healthCircleEl.setAttribute('class', 'text-amber-400 transition-all duration-700');
      } else {
        healthCircleEl.setAttribute('class', 'text-rose-500 transition-all duration-700');
      }
    }
  }

  if (healthBadgeEl && healthDescEl) {
    if (!isOnline) {
      healthBadgeEl.textContent = 'SYSTEM OFFLINE';
      healthBadgeEl.className = 'badge-critical text-[11px] font-bold px-2 py-0.5 rounded-full animate-pulse';
      healthDescEl.textContent = 'ESP32 Hardware Node is offline or disconnected. Live values zeroed out (000) for safety.';
    } else if (healthScore >= 85) {
      healthBadgeEl.textContent = 'OPTIMAL';
      healthBadgeEl.className = 'badge-normal text-[11px] font-bold px-2 py-0.5 rounded-full';
      healthDescEl.textContent = 'All 4 monitored core parameters are within optimal biological conditions for shrimp growth.';
    } else if (healthScore >= 60) {
      healthBadgeEl.textContent = 'ATTENTION';
      healthBadgeEl.className = 'badge-warning text-[11px] font-bold px-2 py-0.5 rounded-full';
      healthDescEl.textContent = `${warningCount} parameter(s) showing slight deviation. Oxygen Turbines may trigger automated compensation.`;
    } else {
      healthBadgeEl.textContent = 'CRITICAL';
      healthBadgeEl.className = 'badge-critical text-[11px] font-bold px-2 py-0.5 rounded-full';
      healthDescEl.textContent = `${criticalCount} parameter(s) in critical violation! Oxygen Turbines engaged at maximum rate.`;
    }
  }

  // Update prominent Water Temperature Hero, Header & Visualizer readouts
  const rawTemp = current.temperature !== undefined ? Number(current.temperature) : 28.4;
  const tempC = !isOnline ? '000' : rawTemp.toFixed(1);
  const tempF = !isOnline ? '000' : ((rawTemp * 9/5) + 32).toFixed(1);

  const heroTempVal = document.getElementById('hero-temp-val');
  const heroTempF = document.getElementById('hero-temp-f');
  const heroTempBadge = document.getElementById('hero-temp-badge');
  const headerTempVal = document.getElementById('header-temp-val');
  const valTempF = document.getElementById('val-temperature-f');
  const simTempVal = document.getElementById('sim-temp-val');
  const simTempF = document.getElementById('sim-temp-f');

  if (heroTempVal) heroTempVal.textContent = !isOnline ? '000 °C' : `${tempC}°C`;
  if (heroTempF) heroTempF.textContent = !isOnline ? '(000 °F)' : `(${tempF}°F)`;
  if (headerTempVal) headerTempVal.textContent = !isOnline ? '000 °C' : `${tempC}°C`;
  if (valTempF) valTempF.textContent = !isOnline ? '(000 °F)' : `(${tempF} °F)`;
  if (simTempVal) simTempVal.textContent = !isOnline ? '000 °C' : `${tempC}°C`;
  if (simTempF) simTempF.textContent = !isOnline ? '(000 °F)' : `(${tempF}°F)`;

  if (heroTempBadge) {
    if (!isOnline) {
      heroTempBadge.textContent = 'OFFLINE';
      heroTempBadge.className = 'badge-critical text-[9px] font-bold px-1.5 py-0.2 rounded-full animate-pulse';
    } else {
      const tempSettings = settings.temperature || { min: 26.0, max: 32.0 };
      if (rawTemp >= tempSettings.min && rawTemp <= tempSettings.max) {
        heroTempBadge.textContent = 'OPTIMAL';
        heroTempBadge.className = 'badge-normal text-[9px] font-bold px-1.5 py-0.2 rounded-full';
      } else if (rawTemp > tempSettings.max) {
        heroTempBadge.textContent = 'HIGH TEMP';
        heroTempBadge.className = 'badge-critical text-[9px] font-bold px-1.5 py-0.2 rounded-full animate-pulse';
      } else {
        heroTempBadge.textContent = 'LOW TEMP';
        heroTempBadge.className = 'badge-warning text-[9px] font-bold px-1.5 py-0.2 rounded-full';
      }
    }
  }

  // Update Oxygen Turbine Dedicated Hero Panel
  updateTurbineHeroPanel(isOnline);

  // Update quick bar actuator indicators
  updateQuickActuators();
  updatePondVisualizer();
}

function updateTurbineHeroPanel(isOnline) {
  const ctrl = appState.control;
  const turbineBadge = document.getElementById('turbine-live-badge');
  const icon = document.getElementById('hero-turbine-icon');
  const iconBox = document.getElementById('hero-turbine-icon-box');

  const btnAuto = document.getElementById('hero-btn-turbine-auto');
  const btnOn = document.getElementById('hero-btn-turbine-on');
  const btnOff = document.getElementById('hero-btn-turbine-off');

  const setBtn = (btn, active) => {
    if (!btn) return;
    if (active) {
      btn.className = 'px-2.5 py-1 text-xs font-semibold rounded-lg bg-cyan-500/25 text-cyan-300 border border-cyan-500/40 shadow-sm';
    } else {
      btn.className = 'px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-400 hover:text-white transition-all';
    }
  };

  setBtn(btnAuto, ctrl.oxygenTurbine === 'AUTO');
  setBtn(btnOn, ctrl.oxygenTurbine === 'ON');
  setBtn(btnOff, ctrl.oxygenTurbine === 'OFF');

  if (turbineBadge) {
    if (!isOnline) {
      turbineBadge.textContent = 'OFFLINE (SAFE HOLD)';
      turbineBadge.className = 'badge-critical text-[10px] font-bold px-2 py-0.5 rounded-full';
      if (icon) icon.classList.remove('animate-spin-slow');
      if (iconBox) iconBox.className = 'w-12 h-12 rounded-2xl bg-slate-800 text-slate-400 border border-slate-700 flex items-center justify-center';
    } else if (ctrl.oxygenTurbineActive) {
      turbineBadge.textContent = `${ctrl.oxygenTurbine} (RUNNING)`;
      turbineBadge.className = 'badge-normal text-[10px] font-bold px-2 py-0.5 rounded-full animate-pulse';
      if (icon) icon.classList.add('animate-spin-slow');
      if (iconBox) iconBox.className = 'w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 flex items-center justify-center shadow-lg shadow-emerald-500/20';
    } else {
      turbineBadge.textContent = `${ctrl.oxygenTurbine} (STANDBY)`;
      turbineBadge.className = 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700';
      if (icon) icon.classList.remove('animate-spin-slow');
      if (iconBox) iconBox.className = 'w-12 h-12 rounded-2xl bg-slate-800/80 text-cyan-400 border border-slate-700 flex items-center justify-center';
    }
  }
}

// Auxiliary Cards Toggle (Ammonia & Hardness)
function toggleAuxiliaryCards() {
  const container = document.getElementById('auxiliary-cards-container');
  const icon = document.getElementById('aux-toggle-icon');
  if (!container) return;
  const isHidden = container.classList.contains('hidden');
  if (isHidden) {
    container.classList.remove('hidden');
    if (icon) icon.style.transform = 'rotate(0deg)';
  } else {
    container.classList.add('hidden');
    if (icon) icon.style.transform = 'rotate(-90deg)';
  }
}

// Hardware Disconnect Test Handler for Viva Demo
async function toggleHardwareOffline(force) {
  try {
    let url = '/api/hardware/toggle-offline';
    if (force !== undefined) {
      url += `?force_offline=${force}`;
    }
    const res = await fetch(url, { method: 'POST' });
    const json = await res.json();
    appState.isOnline = json.isOnline;
    appState.systemStatus = json.systemStatus;
    updateLiveDashboard();
    checkStaleAndTick();
    showToast(json.message, json.isOnline ? 'success' : 'error');
  } catch (e) {
    showToast('Failed to toggle hardware state', 'error');
  }
}

function updateQuickActuators() {
  const ctrl = appState.control;
  const updateDevice = (name, mode, active, dotId, valId) => {
    const dot = document.getElementById(dotId);
    const val = document.getElementById(valId);
    if (dot) {
      dot.className = active 
        ? 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse' 
        : 'w-2 h-2 rounded-full bg-slate-500';
    }
    if (val) {
      val.textContent = `${mode} (${active ? 'ON' : 'OFF'})`;
      val.className = active ? 'font-bold text-emerald-400 font-mono' : 'font-bold text-slate-400 font-mono';
    }
  };

  // Turbine 1: Dissolved Oxygen Turbine (GPIO 18)
  updateDevice('oxygenTurbine', ctrl.oxygenTurbine, ctrl.oxygenTurbineActive, 'quick-dot-turbine', 'quick-val-turbine');
  updateDevice('oxygenTurbine', ctrl.oxygenTurbine, ctrl.oxygenTurbineActive, 'quick-dot-aerator', 'quick-val-aerator');

  // Turbine 2: Water Circulation Turbine (GPIO 19)
  updateDevice('waterTurbine', ctrl.waterTurbine, ctrl.waterTurbineActive, 'quick-dot-water', 'quick-val-water');
  updateDevice('waterTurbine', ctrl.waterTurbine, ctrl.waterTurbineActive, 'quick-dot-pump', 'quick-val-pump');

  // Sidebar indicators
  const sTurbine = document.getElementById('sidebar-turbine-state');
  const sWater = document.getElementById('sidebar-water-state');
  const sAerator = document.getElementById('sidebar-aerator-state');
  const sPump = document.getElementById('sidebar-pump-state');

  const doText = `${ctrl.oxygenTurbine} (${ctrl.oxygenTurbineActive ? 'ON' : 'OFF'})`;
  const waterText = `${ctrl.waterTurbine} (${ctrl.waterTurbineActive ? 'ON' : 'OFF'})`;

  if (sTurbine) sTurbine.textContent = doText;
  if (sAerator) sAerator.textContent = doText;
  if (sWater) sWater.textContent = waterText;
  if (sPump) sPump.textContent = waterText;
}

// --- DEVICE CONTROL MODULE (2 TURBINES: DO TURBINE & WATER TURBINE) ---
function updateControlUI() {
  const ctrl = appState.control;

  const devices = [
    { key: 'oxygenTurbine', prefix: 'turbine', altPrefix: 'aerator', mode: ctrl.oxygenTurbine, active: ctrl.oxygenTurbineActive, icon: 'icon-turbine', badge: 'badge-actuator-turbine', container: 'icon-container-turbine' },
    { key: 'waterTurbine', prefix: 'water', altPrefix: 'pump', mode: ctrl.waterTurbine, active: ctrl.waterTurbineActive, icon: 'icon-water', badge: 'badge-actuator-water', container: 'icon-container-water' }
  ];

  devices.forEach(d => {
    // Mode button highlights
    ['auto', 'on', 'off'].forEach(m => {
      const btn = document.getElementById(`btn-${d.prefix}-${m}`) || document.getElementById(`btn-${d.altPrefix}-${m}`);
      if (!btn) return;
      const isSelected = (d.mode.toLowerCase() === m);
      if (isSelected) {
        btn.className = 'py-2 rounded-lg text-xs font-bold transition-all bg-cyan-500/25 text-cyan-300 border border-cyan-500/40 shadow-sm';
      } else {
        btn.className = 'py-2 rounded-lg text-xs font-medium transition-all text-slate-400 hover:text-slate-200 hover:bg-slate-800';
      }
    });

    // Running state badge
    const badgeEl = document.getElementById(d.badge) || document.getElementById(`badge-actuator-${d.altPrefix}`);
    if (badgeEl) {
      if (d.active) {
        badgeEl.textContent = 'RUNNING';
        badgeEl.className = 'text-xs font-bold font-mono px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 animate-pulse';
      } else {
        badgeEl.textContent = 'IDLE';
        badgeEl.className = 'text-xs font-bold font-mono px-2.5 py-1 rounded-full bg-slate-800 text-slate-400 border border-slate-700';
      }
    }

    // Equipment animation
    const iconEl = document.getElementById(d.icon) || document.getElementById(`icon-${d.altPrefix}`);
    const containerEl = document.getElementById(d.container) || document.getElementById(`icon-container-${d.altPrefix}`);
    if (iconEl && containerEl) {
      if (d.active) {
        iconEl.classList.add('animate-spin-slow');
        containerEl.className = 'w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-300 flex items-center justify-center border border-emerald-500/40 shadow-lg shadow-emerald-500/10';
      } else {
        iconEl.classList.remove('animate-spin-slow');
        containerEl.className = 'w-12 h-12 rounded-2xl bg-slate-800 text-slate-400 flex items-center justify-center border border-slate-700';
      }
    }
  });

  updateQuickActuators();
  updatePondVisualizer();
}

async function setActuatorMode(device, mode) {
  playSound('click');
  
  // Normalize device names: map legacy aliases to the 2 Turbines
  let normalizedDevice = device;
  if (device === 'aerator') normalizedDevice = 'oxygenTurbine';
  if (device === 'waterPump' || device === 'pump') normalizedDevice = 'waterTurbine';

  const update = { [normalizedDevice]: mode };
  appState.control[normalizedDevice] = mode;
  if (normalizedDevice === 'oxygenTurbine') appState.control.aerator = mode;
  if (normalizedDevice === 'waterTurbine') appState.control.waterPump = mode;

  updateControlUI();
  updateTurbineHeroPanel(appState.isOnline !== undefined ? appState.isOnline : true);

  const deviceLabel = normalizedDevice === 'oxygenTurbine' ? 'Dissolved Oxygen Turbine' : 'Water Circulation Turbine';
  showToast(`Toggled ${deviceLabel} mode to ${mode}`, 'info');

  await sendControlUpdate(update);
}

// --- API SENDER FOR TURBINE MODES ---
async function sendControlUpdate(update) {
  try {
    const res = await fetch('/api/pond/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update)
    });
    if (!res.ok) throw new Error('API control update failed');
    const json = await res.json();
    if (json.control) {
      appState.control = { ...appState.control, ...json.control };
    }
    if (json.oxygenTurbineActive !== undefined) appState.control.oxygenTurbineActive = json.oxygenTurbineActive;
    if (json.waterTurbineActive !== undefined) appState.control.waterTurbineActive = json.waterTurbineActive;
    if (json.oxygenTurbine !== undefined) appState.control.oxygenTurbine = json.oxygenTurbine;
    if (json.waterTurbine !== undefined) appState.control.waterTurbine = json.waterTurbine;

    appState.control.aerator = appState.control.oxygenTurbine;
    appState.control.aeratorActive = appState.control.oxygenTurbineActive;
    appState.control.waterPump = appState.control.waterTurbine;
    appState.control.waterPumpActive = appState.control.waterTurbineActive;

    updateControlUI();
    updateTurbineHeroPanel(appState.isOnline !== undefined ? appState.isOnline : true);
  } catch (err) {
    console.error('Failed to send turbine control update:', err);
    showToast('Failed to update turbine state on server', 'error');
  }
}

// --- HISTORICAL TRENDS MODULE & APEXCHARTS ---
function initTrendChart() {
  const chartEl = document.getElementById('historical-chart');
  if (!chartEl) return;

  const options = {
    chart: {
      type: 'area',
      height: 380,
      background: 'transparent',
      toolbar: {
        show: true,
        tools: { download: true, selection: true, zoom: true, zoomin: true, zoomout: true, pan: true, reset: true }
      },
      fontFamily: 'Inter, sans-serif'
    },
    theme: { mode: 'dark' },
    colors: ['#06b6d4', '#10b981', '#f59e0b', '#8b5cf6'],
    dataLabels: { enabled: false },
    stroke: { curve: 'smooth', width: 2.5 },
    fill: {
      type: 'gradient',
      gradient: { shadeIntensity: 1, opacityFrom: 0.45, opacityTo: 0.05, stops: [0, 95, 100] }
    },
    grid: {
      borderColor: 'rgba(255, 255, 255, 0.08)',
      strokeDashArray: 4
    },
    xaxis: {
      type: 'datetime',
      labels: {
        style: { colors: '#94a3b8', fontSize: '11px', fontFamily: 'JetBrains Mono' }
      },
      axisBorder: { color: 'rgba(255, 255, 255, 0.1)' }
    },
    yaxis: {
      labels: {
        style: { colors: '#94a3b8', fontSize: '11px', fontFamily: 'JetBrains Mono' },
        formatter: (val) => typeof val === 'number' ? val.toFixed(1) : val
      }
    },
    tooltip: {
      x: { format: 'dd MMM, HH:mm' },
      theme: 'dark'
    },
    series: [
      { name: 'Dissolved Oxygen (mg/L)', data: [] }
    ]
  };

  appState.chartInstance = new ApexCharts(chartEl, options);
  appState.chartInstance.render();
}

async function fetchHistoricalData(range = '24h') {
  try {
    const res = await fetch(`/api/pond/history?range=${range}`);
    if (!res.ok) throw new Error('History fetch failed');
    const json = await res.json();
    appState.history = json.data || [];
    renderChartData();
  } catch (err) {
    console.error('Failed to fetch history:', err);
  }
}

function renderChartData() {
  if (!appState.chartInstance || !appState.history.length) return;

  const param = appState.trendParam;
  const history = appState.history;
  const chartTitleEl = document.getElementById('chart-title');

  let series = [];
  let statsValues = [];

  if (param === 'overlay_temp_do') {
    if (chartTitleEl) chartTitleEl.textContent = 'Overlay: Water Temperature vs Dissolved Oxygen';
    series = [
      {
        name: 'Dissolved Oxygen (mg/L)',
        data: history.map(d => [d.timestamp, d.dissolvedOxygen])
      },
      {
        name: 'Temperature (°C)',
        data: history.map(d => [d.timestamp, d.temperature])
      }
    ];
    statsValues = history.map(d => d.dissolvedOxygen);

  } else if (param === 'overlay_ph_ammonia') {
    if (chartTitleEl) chartTitleEl.textContent = 'Overlay: pH Level vs Ammonia (TAN)';
    series = [
      {
        name: 'pH Level',
        data: history.map(d => [d.timestamp, d.pH])
      },
      {
        name: 'Ammonia (mg/L)',
        data: history.map(d => [d.timestamp, d.ammonia * 10]) // scaled for visibility
      }
    ];
    statsValues = history.map(d => d.pH);

  } else if (param === 'overlay_all') {
    if (chartTitleEl) chartTitleEl.textContent = 'Multi-Parameter Overview (Normalized)';
    series = [
      { name: 'DO (mg/L)', data: history.map(d => [d.timestamp, d.dissolvedOxygen]) },
      { name: 'pH', data: history.map(d => [d.timestamp, d.pH]) },
      { name: 'Temp (°C)', data: history.map(d => [d.timestamp, d.temperature]) },
      { name: 'Salinity (ppt)', data: history.map(d => [d.timestamp, d.salinity]) }
    ];
    statsValues = history.map(d => d.dissolvedOxygen);

  } else {
    const meta = appState.settings[param] || { label: param, unit: '' };
    if (chartTitleEl) chartTitleEl.textContent = `${meta.label} Historical Trend (${meta.unit})`;
    series = [{
      name: `${meta.label} (${meta.unit})`,
      data: history.map(d => [d.timestamp, d[param]])
    }];
    statsValues = history.map(d => d[param]).filter(v => v !== undefined && !isNaN(v));
  }

  appState.chartInstance.updateSeries(series);

  // Compute and update summary statistics
  if (statsValues.length > 0) {
    const min = Math.min(...statsValues);
    const max = Math.max(...statsValues);
    const sum = statsValues.reduce((a, b) => a + b, 0);
    const avg = sum / statsValues.length;

    const statAvgEl = document.getElementById('stat-avg');
    const statMinEl = document.getElementById('stat-min');
    const statMaxEl = document.getElementById('stat-max');
    const statCountEl = document.getElementById('stat-count');

    if (statAvgEl) statAvgEl.textContent = avg.toFixed(2);
    if (statMinEl) statMinEl.textContent = min.toFixed(2);
    if (statMaxEl) statMaxEl.textContent = max.toFixed(2);
    if (statCountEl) statCountEl.textContent = statsValues.length;
  }
}

function changeTrendView() {
  const select = document.getElementById('trend-param-select');
  if (select) {
    appState.trendParam = select.value;
    renderChartData();
  }
}

async function changeTimeRange(range) {
  appState.timeRange = range;
  ['1h', '24h', '7d'].forEach(r => {
    const btn = document.getElementById(`btn-range-${r}`);
    if (btn) {
      if (r === range) {
        btn.className = 'px-3 py-1.5 rounded-lg transition-all bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-semibold';
      } else {
        btn.className = 'px-3 py-1.5 rounded-lg transition-all text-slate-400 hover:text-white';
      }
    }
  });

  await fetchHistoricalData(range);
}

function exportCSV() {
  if (!appState.history.length) {
    showToast('No historical data available to export', 'warning');
    return;
  }

  let csv = 'Timestamp,ISO_Time,Dissolved_Oxygen_mg_L,pH,Salinity_ppt,Temperature_C,Ammonia_mg_L,Hardness_mg_L\n';
  appState.history.forEach(row => {
    const iso = new Date(row.timestamp).toISOString();
    csv += `${row.timestamp},${iso},${row.dissolvedOxygen},${row.pH},${row.salinity},${row.temperature},${row.ammonia},${row.hardness}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `shrimp_pond_telemetry_${appState.timeRange}_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast('Historical CSV export downloaded successfully', 'success');
}

// --- ALERTS MODULE ---
function renderAlertsTable() {
  const alerts = appState.alerts || [];
  const tbody = document.getElementById('alerts-table-body');
  const countAll = document.getElementById('count-all');
  const countCritical = document.getElementById('count-critical');
  const countWarning = document.getElementById('count-warning');
  const navAlertBadge = document.getElementById('nav-alert-badge');

  const criticals = alerts.filter(a => a.level === 'critical');
  const warnings = alerts.filter(a => a.level === 'warning');

  if (countAll) countAll.textContent = alerts.length;
  if (countCritical) countCritical.textContent = criticals.length;
  if (countWarning) countWarning.textContent = warnings.length;

  if (navAlertBadge) {
    if (criticals.length > 0) {
      navAlertBadge.textContent = criticals.length;
      navAlertBadge.classList.remove('hidden');
    } else {
      navAlertBadge.classList.add('hidden');
    }
  }

  const filtered = alerts.filter(a => {
    if (appState.alertFilter === 'critical') return a.level === 'critical';
    if (appState.alertFilter === 'warning') return a.level === 'warning';
    return true;
  });

  if (!tbody) return;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="px-4 py-8 text-center text-slate-500 font-sans">
          No active violations under current filter. All pond metrics optimal!
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(item => {
    const isCrit = item.level === 'critical';
    const badgeClass = isCrit ? 'badge-critical' : 'badge-warning';
    const dateStr = new Date(item.timestamp).toLocaleString();

    return `
      <tr class="hover:bg-slate-800/40 transition-colors">
        <td class="px-4 py-3">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${badgeClass}">
            ${item.level}
          </span>
        </td>
        <td class="px-4 py-3 font-semibold text-white font-sans">
          ${item.label || item.parameter}
        </td>
        <td class="px-4 py-3 text-cyan-300 font-bold">
          ${item.value} ${item.unit || ''}
        </td>
        <td class="px-4 py-3 text-slate-400">
          ${item.threshold} ${item.unit || ''}
        </td>
        <td class="px-4 py-3 text-slate-300 font-sans">
          ${item.message || 'Threshold out of safe biological range'}
        </td>
        <td class="px-4 py-3 text-right text-slate-400 text-[11px]">
          ${dateStr}
        </td>
      </tr>
    `;
  }).join('');
}

function filterAlerts(filter) {
  appState.alertFilter = filter;
  ['all', 'critical', 'warning'].forEach(f => {
    const btn = document.getElementById(`filter-${f}`);
    if (btn) {
      if (f === filter) {
        btn.className = 'px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-semibold';
      } else {
        btn.className = 'px-3 py-1.5 rounded-lg text-slate-400 hover:text-white';
      }
    }
  });
  renderAlertsTable();
}

async function triggerSimulatedAlert(param, level) {
  try {
    const res = await fetch(`/api/pond/alerts/simulate?parameter=${param}&level=${level}`, { method: 'POST' });
    const json = await res.json();
    if (json.alert) {
      appState.alerts.unshift(json.alert);
      renderAlertsTable();
      showToast(`Triggered ${level.toUpperCase()} alert on ${param}!`, isCrit(level) ? 'error' : 'warning');
    }
  } catch (e) {
    showToast('Failed to simulate alert', 'error');
  }
}

function isCrit(level) {
  return level === 'critical';
}

async function clearAllAlerts() {
  try {
    await fetch('/api/pond/alerts/clear', { method: 'POST' });
    appState.alerts = [];
    renderAlertsTable();
    showToast('Alert log cleared', 'info');
  } catch (e) {
    showToast('Failed to clear alerts', 'error');
  }
}

// --- SETTINGS MODULE ---
function populateSettingsInputs() {
  const s = appState.settings;
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined) el.value = val;
  };

  if (s.dissolvedOxygen) { setVal('thresh-do-min', s.dissolvedOxygen.min); setVal('thresh-do-max', s.dissolvedOxygen.max); }
  if (s.pH) { setVal('thresh-ph-min', s.pH.min); setVal('thresh-ph-max', s.pH.max); }
  if (s.salinity) { setVal('thresh-salinity-min', s.salinity.min); setVal('thresh-salinity-max', s.salinity.max); }
  if (s.temperature) { setVal('thresh-temp-min', s.temperature.min); setVal('thresh-temp-max', s.temperature.max); }
  if (s.ammonia) { setVal('thresh-ammonia-min', s.ammonia.min); setVal('thresh-ammonia-max', s.ammonia.max); }
  if (s.hardness) { setVal('thresh-hardness-min', s.hardness.min); setVal('thresh-hardness-max', s.hardness.max); }
}

function populateConfigInputs(cfg) {
  if (!cfg) return;
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && val) el.value = val;
  };
  setVal('cfg-databaseURL', cfg.databaseURL);
  setVal('cfg-apiKey', cfg.apiKey);
  setVal('cfg-projectId', cfg.projectId);
  setVal('cfg-authDomain', cfg.authDomain);

  const btnSim = document.getElementById('btn-sim-toggle');
  if (btnSim) {
    if (cfg.simulationMode) {
      btnSim.textContent = 'ACTIVE';
      btnSim.className = 'px-2.5 py-1 text-xs font-mono font-bold rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    } else {
      btnSim.textContent = 'PAUSED';
      btnSim.className = 'px-2.5 py-1 text-xs font-mono font-bold rounded-lg bg-slate-800 text-slate-400 border border-slate-700';
    }
  }
}

async function saveThresholdSettings() {
  const getVal = (id) => parseFloat(document.getElementById(id)?.value);

  const updated = {
    dissolvedOxygen: { min: getVal('thresh-do-min'), max: getVal('thresh-do-max'), unit: 'mg/L', label: 'Dissolved Oxygen' },
    pH: { min: getVal('thresh-ph-min'), max: getVal('thresh-ph-max'), unit: '', label: 'pH Level' },
    salinity: { min: getVal('thresh-salinity-min'), max: getVal('thresh-salinity-max'), unit: 'ppt', label: 'Salinity' },
    temperature: { min: getVal('thresh-temp-min'), max: getVal('thresh-temp-max'), unit: '°C', label: 'Temperature' },
    ammonia: { min: getVal('thresh-ammonia-min'), max: getVal('thresh-ammonia-max'), unit: 'mg/L', label: 'Ammonia (TAN)' },
    hardness: { min: getVal('thresh-hardness-min'), max: getVal('thresh-hardness-max'), unit: 'mg/L', label: 'Total Hardness' }
  };

  appState.settings = updated;
  updateLiveDashboard();

  await sendSettingsUpdate(updated);
  showToast('Settings saved to /pond/settings and server!', 'success');
}

async function sendSettingsUpdate(updated) {
  try {
    const res = await fetch('/api/pond/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated)
    });
    if (!res.ok) throw new Error('Failed to update settings');
    const json = await res.json();
    if (json.settings) {
      appState.settings = json.settings;
      populateSettingsInputs();
    }
  } catch (err) {
    console.error('Error saving settings to API:', err);
    showToast('Failed to save settings on server', 'error');
  }
}

async function resetThresholdsToDefaults() {
  try {
    const res = await fetch('/api/pond/settings/reset', { method: 'POST' });
    const json = await res.json();
    if (json.settings) {
      appState.settings = json.settings;
      populateSettingsInputs();
      updateLiveDashboard();
      showToast('Thresholds reset to default safe biological values', 'info');
    }
  } catch (e) {
    showToast('Failed to reset thresholds', 'error');
  }
}

async function saveFirebaseCredentials() {
  const cfg = {
    databaseURL: document.getElementById('cfg-databaseURL')?.value.trim(),
    apiKey: document.getElementById('cfg-apiKey')?.value.trim(),
    projectId: document.getElementById('cfg-projectId')?.value.trim(),
    authDomain: document.getElementById('cfg-authDomain')?.value.trim()
  };

  localStorage.setItem('shrimp_firebase_config', JSON.stringify(cfg));

  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
  } catch (e) {
    console.warn('Backend config sync notice:', e);
  }

  const success = initFirebaseApp();
  if (success) {
    setupRealtimeListeners();
    showToast('Connected to Firebase Realtime Database!', 'success');
  } else {
    showToast('Saved config. Running in hybrid local mode.', 'info');
  }
}

async function toggleTelemetrySimulator() {
  try {
    const res = await fetch('/api/simulator/toggle', { method: 'POST' });
    const json = await res.json();
    const btnSim = document.getElementById('btn-sim-toggle');
    if (btnSim) {
      if (json.simulationMode) {
        btnSim.textContent = 'ACTIVE';
        btnSim.className = 'px-2.5 py-1 text-xs font-mono font-bold rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
        showToast('Background telemetry simulator activated', 'success');
      } else {
        btnSim.textContent = 'PAUSED';
        btnSim.className = 'px-2.5 py-1 text-xs font-mono font-bold rounded-lg bg-slate-800 text-slate-400 border border-slate-700';
        showToast('Telemetry simulator paused (waiting for real ESP32)', 'info');
      }
    }
  } catch (e) {
    showToast('Failed to toggle simulator', 'error');
  }
}

// --- TOAST NOTIFICATIONS ---
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const bgColors = {
    success: 'bg-emerald-600/90 border-emerald-400/40 text-white',
    error: 'bg-rose-600/90 border-rose-400/40 text-white',
    warning: 'bg-amber-600/90 border-amber-400/40 text-white',
    info: 'bg-slate-800/90 border-slate-600 text-cyan-200'
  };

  toast.className = `px-4 py-2.5 rounded-xl border text-xs font-semibold shadow-xl backdrop-blur flex items-center gap-2 transform transition-all duration-300 translate-y-2 opacity-0 ${bgColors[type] || bgColors.info}`;
  toast.innerHTML = `<span>${message}</span>`;

  container.appendChild(toast);

  // Trigger fade in
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  // Remove after 3.5s
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// Global Refresh Helper
async function refreshData() {
  playSound('click');
  await fetchAllPondData();
  showToast('Dashboard synchronized', 'info');
}

// --- AUDIO SYNTHESIZER (WEB AUDIO API) ---
let audioCtx = null;
let soundEnabled = true;

function initAudio() {
  if (!audioCtx && (typeof window.AudioContext !== 'undefined' || typeof window.webkitAudioContext !== 'undefined')) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function toggleAudio() {
  soundEnabled = !soundEnabled;
  const btn = document.getElementById('audio-toggle-btn');
  if (btn) {
    if (soundEnabled) {
      btn.innerHTML = `<i data-lucide="volume-2" id="audio-icon" class="w-4 h-4 text-cyan-400"></i><span class="hidden sm:inline text-[11px] font-mono">Sound ON</span>`;
      playSound('click');
      showToast('Sound FX Enabled', 'info');
    } else {
      btn.innerHTML = `<i data-lucide="volume-x" id="audio-icon" class="w-4 h-4 text-slate-500"></i><span class="hidden sm:inline text-[11px] font-mono text-slate-500">Muted</span>`;
      showToast('Sound FX Muted', 'info');
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
}

function playSound(type) {
  if (!soundEnabled) return;
  try {
    initAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;

    if (type === 'click') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(950, now + 0.07);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
      osc.start(now);
      osc.stop(now + 0.07);
    } else if (type === 'warning') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(480, now);
      osc.frequency.setValueAtTime(640, now + 0.1);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.start(now);
      osc.stop(now + 0.25);
    } else if (type === 'critical') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(440, now + 0.35);
      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
      osc.start(now);
      osc.stop(now + 0.38);
    }
  } catch (e) {
    // Audio failure tolerance
  }
}

// --- INTERACTIVE POND PHYSICAL VISUALIZER ---
function updatePondVisualizer() {
  const ctrl = appState.control;
  const current = appState.current;

  // Surface Aerator Paddle
  const aeratorPaddle = document.getElementById('sim-aerator-paddle');
  const aeratorSplash = document.getElementById('sim-aerator-splash');
  const aeratorLabel = document.getElementById('sim-aerator-text');

  if (aeratorLabel) {
    aeratorLabel.textContent = `${ctrl.aerator} (${ctrl.aeratorActive ? 'ON' : 'OFF'})`;
  }
  if (aeratorPaddle && aeratorSplash) {
    if (ctrl.aeratorActive) {
      aeratorPaddle.className = 'w-10 h-10 rounded-full bg-gradient-to-tr from-cyan-500 to-emerald-400 flex items-center justify-center text-slate-950 shadow-lg shadow-cyan-400/50 animate-spin-fast';
      aeratorSplash.classList.remove('hidden');
    } else {
      aeratorPaddle.className = 'w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 border border-slate-700';
      aeratorSplash.classList.add('hidden');
    }
  }

  // Deep Venturi Turbine
  const turbineWheel = document.getElementById('sim-turbine-wheel');
  const turbineLabel = document.getElementById('sim-turbine-label');
  const bubblesContainer = document.getElementById('sim-bubbles-container');

  if (turbineLabel) {
    turbineLabel.textContent = `${ctrl.oxygenTurbine} (${ctrl.oxygenTurbineActive ? 'ON' : 'OFF'})`;
  }
  if (turbineWheel) {
    if (ctrl.oxygenTurbineActive) {
      turbineWheel.className = 'w-6 h-6 rounded-full bg-emerald-500/30 flex items-center justify-center text-emerald-300 border border-emerald-400 animate-spin-fast shadow-md shadow-emerald-500/40';
      // Populate rising bubbles if empty
      if (bubblesContainer && bubblesContainer.children.length === 0) {
        bubblesContainer.innerHTML = Array.from({ length: 14 }).map((_, i) => {
          const left = 20 + Math.random() * 60;
          const size = 6 + Math.random() * 12;
          const delay = (Math.random() * 3).toFixed(1);
          const dur = (2 + Math.random() * 2).toFixed(1);
          return `<div class="bubble" style="left: ${left}%; width: ${size}px; height: ${size}px; animation-duration: ${dur}s; animation-delay: ${delay}s;"></div>`;
        }).join('');
      }
    } else {
      turbineWheel.className = 'w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-slate-500 border border-slate-700';
      if (bubblesContainer) bubblesContainer.innerHTML = '';
    }
  }

  // Inflow Water Pump
  const pumpWheel = document.getElementById('sim-pump-wheel');
  const pumpLabel = document.getElementById('sim-pump-label');

  if (pumpLabel) {
    pumpLabel.textContent = `${ctrl.waterPump} (${ctrl.waterPumpActive ? 'ON' : 'OFF'})`;
  }
  if (pumpWheel) {
    if (ctrl.waterPumpActive) {
      pumpWheel.className = 'w-6 h-6 rounded-full bg-blue-500/30 flex items-center justify-center text-blue-300 border border-blue-400 animate-spin-fast shadow-md shadow-blue-500/40';
    } else {
      pumpWheel.className = 'w-6 h-6 rounded-full bg-slate-800 flex items-center justify-center text-slate-500 border border-slate-700';
    }
  }

  // Benthic DO Saturation calculation
  const doVal = current.dissolvedOxygen || 6.0;
  const doSatPct = Math.min(130, Math.round((doVal / 7.5) * 100));
  const doPctEl = document.getElementById('sim-do-pct');
  if (doPctEl) {
    doPctEl.textContent = `${doSatPct}% (${doVal.toFixed(1)} mg/L)`;
    doPctEl.className = (doVal >= 4.0) ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold animate-pulse';
  }
}

// --- SENSOR TUNING SANDBOX LOGIC ---
function toggleSandbox() {
  const drawer = document.getElementById('sandbox-drawer');
  if (!drawer) return;
  playSound('click');
  const isHidden = drawer.classList.contains('hidden');
  if (isHidden) {
    drawer.classList.remove('hidden');
    syncSandboxSlidersFromState();
  } else {
    drawer.classList.add('hidden');
  }
}

function syncSandboxSlidersFromState() {
  const cur = appState.current;
  const setSlider = (id, val, textId, unit = '') => {
    const s = document.getElementById(id);
    const t = document.getElementById(textId);
    if (s && val !== undefined) s.value = val;
    if (t && val !== undefined) t.textContent = `${val} ${unit}`;
  };

  setSlider('sb-slider-do', cur.dissolvedOxygen, 'sb-val-do', 'mg/L');
  setSlider('sb-slider-ph', cur.pH, 'sb-val-ph', '');
  setSlider('sb-slider-salinity', cur.salinity, 'sb-val-salinity', 'ppt');
  setSlider('sb-slider-temp', cur.temperature, 'sb-val-temp', '°C');
  setSlider('sb-slider-ammonia', cur.ammonia, 'sb-val-ammonia', 'mg/L');
  setSlider('sb-slider-hardness', cur.hardness, 'sb-val-hardness', 'mg/L');
}

function onSandboxSliderChange() {
  const getVal = (id) => parseFloat(document.getElementById(id)?.value);

  const doVal = getVal('sb-slider-do');
  const phVal = getVal('sb-slider-ph');
  const salVal = getVal('sb-slider-salinity');
  const tempVal = getVal('sb-slider-temp');
  const ammVal = getVal('sb-slider-ammonia');
  const hardVal = getVal('sb-slider-hardness');

  // Update slider labels
  const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  setTxt('sb-val-do', `${doVal.toFixed(1)} mg/L`);
  setTxt('sb-val-ph', `${phVal.toFixed(1)}`);
  setTxt('sb-val-salinity', `${salVal.toFixed(1)} ppt`);
  setTxt('sb-val-temp', `${tempVal.toFixed(1)} °C`);
  setTxt('sb-val-ammonia', `${ammVal.toFixed(3)} mg/L`);
  setTxt('sb-val-hardness', `${Math.round(hardVal)} mg/L`);

  // Instant update to appState.current
  appState.current.dissolvedOxygen = doVal;
  appState.current.pH = phVal;
  appState.current.salinity = salVal;
  appState.current.temperature = tempVal;
  appState.current.ammonia = ammVal;
  appState.current.hardness = hardVal;
  appState.current.timestamp = Date.now();

  // Evaluate automatic equipment rules
  if (appState.control.aerator === 'AUTO') {
    appState.control.aeratorActive = (doVal < appState.settings.dissolvedOxygen.min);
  }
  if (appState.control.oxygenTurbine === 'AUTO') {
    appState.control.oxygenTurbineActive = (doVal < 3.8);
  }
  if (appState.control.waterPump === 'AUTO') {
    appState.control.waterPumpActive = (ammVal > appState.settings.ammonia.max || tempVal > appState.settings.temperature.max);
  }

  // Audio tone on critical breach
  if (doVal < 3.5 || ammVal > 0.1) {
    playSound('warning');
  }

  updateLiveDashboard();
  updatePondVisualizer();
}

function applySandboxPreset(preset) {
  playSound('click');
  const setSlider = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

  if (preset === 'optimal') {
    setSlider('sb-slider-do', 6.8);
    setSlider('sb-slider-ph', 7.9);
    setSlider('sb-slider-salinity', 18.0);
    setSlider('sb-slider-temp', 28.0);
    setSlider('sb-slider-ammonia', 0.02);
    setSlider('sb-slider-hardness', 200);
    showToast('Applied Optimal Morning preset', 'success');
  } else if (preset === 'low_do') {
    setSlider('sb-slider-do', 2.8);
    setSlider('sb-slider-ph', 7.4);
    setSlider('sb-slider-salinity', 18.0);
    setSlider('sb-slider-temp', 29.5);
    setSlider('sb-slider-ammonia', 0.04);
    setSlider('sb-slider-hardness', 190);
    showToast('Simulated Night DO Suffocation Crisis!', 'error');
    playSound('critical');
  } else if (preset === 'high_ammonia') {
    setSlider('sb-slider-do', 5.0);
    setSlider('sb-slider-ph', 8.6);
    setSlider('sb-slider-salinity', 17.5);
    setSlider('sb-slider-temp', 29.0);
    setSlider('sb-slider-ammonia', 0.28);
    setSlider('sb-slider-hardness', 180);
    showToast('Simulated Toxic Ammonia Spike!', 'error');
    playSound('critical');
  } else if (preset === 'heatwave') {
    setSlider('sb-slider-do', 5.2);
    setSlider('sb-slider-ph', 8.5);
    setSlider('sb-slider-salinity', 24.0);
    setSlider('sb-slider-temp', 34.2);
    setSlider('sb-slider-ammonia', 0.08);
    setSlider('sb-slider-hardness', 220);
    showToast('Simulated Midday Heatwave Event', 'warning');
    playSound('warning');
  }

  onSandboxSliderChange();
}

async function commitSandboxReading() {
  playSound('click');
  const payload = {
    dissolvedOxygen: appState.current.dissolvedOxygen,
    pH: appState.current.pH,
    salinity: appState.current.salinity,
    temperature: appState.current.temperature,
    ammonia: appState.current.ammonia,
    hardness: appState.current.hardness,
    timestamp: Date.now()
  };

  try {
    const res = await fetch('/api/pond/current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast('Pushed sandbox values to Cloud Firebase & Server!', 'success');
      toggleSandbox();
      await fetchAllPondData();
    }
  } catch (e) {
    showToast('Failed to commit sandbox values', 'error');
  }
}

// --- PARAMETER DIAGNOSTIC MODAL ---
const PARAM_DIAGNOSTICS = {
  dissolvedOxygen: {
    title: 'Dissolved Oxygen (DO)',
    unit: 'mg/L',
    icon: 'wind',
    importance: 'Dissolved Oxygen is the single most vital factor in shrimp aquaculture. Levels below 3.5 mg/L cause postlarval suffocation, stop molting development, and spike mortality. Optimum growth occurs between 5.0 - 8.0 mg/L.',
    rule: 'Surface Aerator turns ON automatically when DO < 4.0 mg/L. Deep Oxygen Venturi Turbine triggers when DO drops critically below 3.8 mg/L.'
  },
  pH: {
    title: 'pH Level (Water Acidity)',
    unit: 'pH',
    icon: 'flask-conical',
    importance: 'Pond water pH regulates ion balance and ammonia equilibrium. Low pH (< 7.0) leads to soft shells and poor mineral uptake. High pH (> 9.0) drastically shifts ammonium (NH4+) into deadly toxic free ammonia (NH3 gas).',
    rule: 'Safe band: 7.5 - 8.5. If pH drifts out of limits, manual liming or flushing with the fresh water pump is recommended.'
  },
  salinity: {
    title: 'Water Salinity',
    unit: 'ppt',
    icon: 'waves',
    importance: 'Salinity governs osmoregulatory energy expenditure in Penaeus vannamei. Rapid shifts shock postlarvae and interfere with carapace molting cycles. Ideal salinity maintains low stress and maximum feed conversion.',
    rule: 'Optimal range: 10 - 25 ppt. Monitored continuously to prevent osmotic stress during heavy rainfall or evaporation.'
  },
  temperature: {
    title: 'Water Temperature',
    unit: '°C',
    icon: 'thermometer',
    importance: 'Controls metabolic activity, digestion speed, and feed intake. Temperatures > 32°C accelerate harmful bacterial proliferation and reduce oxygen solubility. Temperatures < 25°C cause shrimp to stop feeding.',
    rule: 'When water temperature exceeds 32.0°C, the Inflow Water Pump automatically triggers to circulate cooler replacement water.'
  },
  ammonia: {
    title: 'Total Ammonia Nitrogen (TAN)',
    unit: 'mg/L',
    icon: 'alert-octagon',
    importance: 'Un-ionized ammonia (NH3) is highly lethal to shrimp gills and hemolymph. Levels above 0.10 mg/L cause gill necrosis, black gill disease, and catastrophic mortality within hours.',
    rule: 'When Ammonia > 0.10 mg/L, the system sounds critical alarms and triggers the Inflow Fresh Water Pump in AUTO mode.'
  },
  hardness: {
    title: 'Total Hardness (CaCO₃ Minerals)',
    unit: 'mg/L',
    icon: 'layers',
    importance: 'Provides the essential dissolved calcium and magnesium ions required by shrimp to harden their new exoskeleton immediately following ecdysis (molting). Low hardness causes soft-shell syndrome and cannibalism.',
    rule: 'Maintained between 100 - 300 mg/L CaCO3 to ensure regular synchronized molting without shell deformities.'
  }
};

function openParamModal(paramKey) {
  const diag = PARAM_DIAGNOSTICS[paramKey];
  if (!diag) return;
  playSound('click');

  const curVal = appState.current[paramKey];
  const settings = appState.settings[paramKey] || { min: 0, max: 100 };

  const titleEl = document.getElementById('modal-param-title');
  const valEl = document.getElementById('modal-param-value');
  const rangeEl = document.getElementById('modal-param-range');
  const statusEl = document.getElementById('modal-param-status');
  const importEl = document.getElementById('modal-param-importance');
  const ruleEl = document.getElementById('modal-param-rule');
  const iconEl = document.getElementById('modal-param-icon');

  if (titleEl) titleEl.textContent = diag.title;
  if (valEl) valEl.textContent = `${(curVal !== undefined) ? (paramKey === 'ammonia' ? curVal.toFixed(3) : curVal.toFixed(1)) : '--'} ${diag.unit}`;
  if (rangeEl) rangeEl.textContent = `${settings.min} - ${settings.max} ${diag.unit}`;
  if (importEl) importEl.textContent = diag.importance;
  if (ruleEl) ruleEl.textContent = diag.rule;

  if (iconEl) {
    iconEl.innerHTML = `<i data-lucide="${diag.icon}" class="w-5 h-5"></i>`;
  }

  // Determine status
  let status = 'OPTIMAL';
  let badgeClass = 'badge-normal';
  if (curVal < settings.min || curVal > settings.max) {
    const diff = Math.abs(curVal < settings.min ? settings.min - curVal : curVal - settings.max);
    if (diff > (settings.max - settings.min) * 0.25 || (paramKey === 'ammonia' && curVal > 0.1)) {
      status = 'CRITICAL VIOLATION';
      badgeClass = 'badge-critical';
    } else {
      status = 'WARNING DEVIATION';
      badgeClass = 'badge-warning';
    }
  }

  if (statusEl) {
    statusEl.textContent = status;
    statusEl.className = `${badgeClass} text-xs font-bold px-2.5 py-0.5 rounded-full`;
  }

  const modal = document.getElementById('param-detail-modal');
  if (modal) modal.classList.remove('hidden');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function closeParamModal() {
  playSound('click');
  const modal = document.getElementById('param-detail-modal');
  if (modal) modal.classList.add('hidden');
}

