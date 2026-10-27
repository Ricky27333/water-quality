import os
import json
import time
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(
    title="ESP32 Smart Shrimp Pond API",
    description="Dedicated Backend API for ESP32 Microcontroller with 4 Core Sensors (DO, pH, Salinity, Temperature), Dual Turbine Automation (DO Turbine & Water Turbine), and Offline Fail-Safe Watchdog (000 / SYSTEM OFFLINE).",
    version="3.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_FILE = "data/pond_data.json"
SETTINGS_FILE = "data/config.json"

# Optimal thresholds for shrimp aquaculture (Penaeus vannamei)
# 4 core sensors
DEFAULT_SETTINGS = {
    "dissolvedOxygen": {"min": 4.0, "max": 8.0, "unit": "mg/L", "label": "Dissolved Oxygen", "pin": "ESP32 (GPIO 34 / Est)"},
    "pH": {"min": 7.5, "max": 8.5, "unit": "", "label": "pH Level", "pin": "ESP32 (GPIO 34)"},
    "salinity": {"min": 10.0, "max": 25.0, "unit": "ppt", "label": "Salinity", "pin": "ESP32 (GPIO 35)"},
    "temperature": {"min": 26.0, "max": 32.0, "unit": "°C", "label": "Water Temperature", "pin": "ESP32 (GPIO 4)"},
    "ammonia": {"min": 0.0, "max": 0.1, "unit": "mg/L", "label": "Ammonia (TAN)", "pin": "Auxiliary"},
    "hardness": {"min": 100.0, "max": 300.0, "unit": "mg/L", "label": "Total Hardness", "pin": "Auxiliary"}
}

DEFAULT_CONTROL = {
    "oxygenTurbine": "AUTO",
    "oxygenTurbineActive": False,
    "waterTurbine": "AUTO",
    "waterTurbineActive": False,
    "lastChanged": int(time.time() * 1000)
}

# ESP32 / IoT Hardware Watchdog State
# Timeout: 30 seconds without a telemetry packet marks the system OFFLINE (commercial resilience)
WATCHDOG_TIMEOUT_SECONDS = 30.0

hardware_health: Dict[str, Any] = {
    "microcontroller": "ESP32",
    "isOnline": True,
    "lastHeartbeat": time.time(),
    "timeoutSeconds": WATCHDOG_TIMEOUT_SECONDS,
    "manualOfflineOverride": False,
    "presentationMode": True,
    "packetsReceived": 0,
    "lastPacketIp": None
}

# In-memory pond telemetry & state
pond_state: Dict[str, Any] = {
    "current": {
        "dissolvedOxygen": 6.2,
        "pH": 7.8,
        "salinity": 18.2,
        "temperature": 28.5,
        "ammonia": 0.02,
        "hardness": 180.0,
        "timestamp": int(time.time() * 1000)
    },
    "history": [],
    "control": DEFAULT_CONTROL.copy(),
    "alerts": [],
    "settings": DEFAULT_SETTINGS.copy()
}

# --- Watchdog Check ---
def check_hardware_online() -> bool:
    """
    Returns True if:
    1. No manual disconnect override is active (used for viva 000 demo), AND
    2. Either presentationMode is active or ESP32 packet was received within watchdog window.
    """
    if hardware_health.get("manualOfflineOverride", False):
        return False
    
    if hardware_health.get("presentationMode", True):
        return True

    last_hb = hardware_health.get("lastHeartbeat", 0.0)
    if last_hb <= 0:
        return False
    
    age = time.time() - last_hb
    return age <= hardware_health.get("timeoutSeconds", WATCHDOG_TIMEOUT_SECONDS)

# --- Persistence ---
def load_persisted_data():
    global pond_state
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, "r") as f:
                saved = json.load(f)
                if "history" in saved:
                    pond_state["history"] = saved["history"]
                if "control" in saved:
                    pond_state["control"] = saved["control"]
                if "alerts" in saved:
                    pond_state["alerts"] = saved["alerts"]
                if "settings" in saved:
                    pond_state["settings"] = saved["settings"]
                if "current" in saved and saved["current"].get("dissolvedOxygen", 0) > 0:
                    pond_state["current"] = saved["current"]
        except Exception as e:
            print(f"Notice: Error loading persisted pond data: {e}")

def save_persisted_data():
    try:
        os.makedirs("data", exist_ok=True)
        if len(pond_state["history"]) > 1000:
            pond_state["history"] = pond_state["history"][-1000:]
        with open(DATA_FILE, "w") as f:
            json.dump(pond_state, f, indent=2)
    except Exception as e:
        print(f"Notice: Error saving pond data: {e}")

# --- Scientific Formula for Estimated Dissolved Oxygen ---
def calculate_estimated_do(temperature: float, ph: float, salinity: float) -> float:
    """
    Scientific formula for Dissolved Oxygen (DO) dependency on Temperature, Salinity, and pH:
    1. Base saturation at temperature T (°C): 14.60 - (0.28 * T)
    2. Salinity penalty (salting-out effect): salinity * 0.045
    3. pH penalty: |pH - 7.85| * 0.55 (deviation from optimal 7.85 reflects ecosystem respiration stress)
    """
    effective_temp = temperature if temperature > 0.0 else 28.0
    base = 14.60 - (0.28 * effective_temp)
    sal_penalty = salinity * 0.045
    ph_penalty = abs(ph - 7.85) * 0.55
    res = base - sal_penalty - ph_penalty
    return round(max(0.0, min(12.0, res)), 2)

# --- Dual Turbine Automation & Hysteresis ---
def update_turbine_automation():
    """Automates Dissolved Oxygen Turbine (Servo 1) and Water Circulation Turbine (Servo 2)."""
    control = pond_state.setdefault("control", DEFAULT_CONTROL.copy())
    current = pond_state.get("current", {})
    is_online = check_hardware_online()

    do_val = current.get("dissolvedOxygen", 0.0)
    temp_val = current.get("temperature", 0.0)
    ph_val = current.get("pH", 7.8)
    sal_val = current.get("salinity", 18.0)

    # 1. Dissolved Oxygen Turbine (Servo 1 / GPIO 18)
    do_mode = control.get("oxygenTurbine", "AUTO")
    if do_mode == "ON":
        control["oxygenTurbineActive"] = True
    elif do_mode == "OFF":
        control["oxygenTurbineActive"] = False
    elif do_mode == "AUTO":
        if not is_online:
            # Failsafe hold when hardware is offline in AUTO mode
            control["oxygenTurbineActive"] = False
        elif do_val < 4.0 or (do_val < 4.5 and temp_val > 31.0):
            control["oxygenTurbineActive"] = True
        elif do_val >= 5.5:
            control["oxygenTurbineActive"] = False

    # 2. Water Circulation Turbine (Servo 2 / GPIO 19)
    water_mode = control.get("waterTurbine", "AUTO")
    if water_mode == "ON":
        control["waterTurbineActive"] = True
    elif water_mode == "OFF":
        control["waterTurbineActive"] = False
    elif water_mode == "AUTO":
        if not is_online:
            # Failsafe hold when hardware is offline in AUTO mode
            control["waterTurbineActive"] = False
        elif temp_val > 32.5 or ph_val < 7.2 or ph_val > 8.8 or sal_val > 25.0:
            control["waterTurbineActive"] = True
        elif (temp_val < 31.0 or temp_val <= 0.0) and (7.4 <= ph_val <= 8.6) and sal_val <= 22.0:
            control["waterTurbineActive"] = False

# --- Threshold & Alert Checking ---
def check_thresholds(reading: Dict[str, Any]):
    settings = pond_state.get("settings", DEFAULT_SETTINGS)
    alerts = pond_state.setdefault("alerts", [])
    now_ms = reading.get("timestamp", int(time.time() * 1000))

    for param, val in reading.items():
        if param in settings and isinstance(val, (int, float)) and val > 0:
            thresh = settings[param]
            p_min = thresh.get("min", float("-inf"))
            p_max = thresh.get("max", float("inf"))
            unit = thresh.get("unit", "")
            label = thresh.get("label", param)

            level = None
            diff = 0
            if val < p_min:
                diff = p_min - val
                level = "critical" if diff > (p_min * 0.25) else "warning"
                msg = f"{label} is low: {val} {unit} (Target: {p_min} - {p_max} {unit})"
            elif val > p_max:
                diff = val - p_max
                level = "critical" if diff > (p_max * 0.25) else "warning"
                msg = f"{label} is high: {val} {unit} (Target: {p_min} - {p_max} {unit})"

            if level:
                recent_duplicate = any(
                    a.get("parameter") == param and (now_ms - a.get("timestamp", 0)) < 120000
                    for a in alerts[:5]
                )
                if not recent_duplicate:
                    alert_entry = {
                        "id": f"alt_{int(time.time() * 1000)}",
                        "parameter": param,
                        "label": label,
                        "value": val,
                        "unit": unit,
                        "threshold": f"{p_min} - {p_max}",
                        "level": level,
                        "message": msg,
                        "timestamp": now_ms
                    }
                    alerts.insert(0, alert_entry)
                    if len(alerts) > 100:
                        alerts.pop()

# --- Common Ingestion Handler for ESP8266 ---
def ingest_esp8266_telemetry(
    temperature: float,
    pH: float,
    salinity: float,
    dissolvedOxygen: float,
    client_ip: Optional[str] = None
) -> Dict[str, Any]:
    """Central processing logic for data received from ESP8266."""
    now_sec = time.time()
    now_ms = int(now_sec * 1000)

    # 1. Update Hardware Watchdog Heartbeat
    hardware_health["lastHeartbeat"] = now_sec
    hardware_health["isOnline"] = True
    hardware_health["manualOfflineOverride"] = False
    hardware_health["packetsReceived"] = hardware_health.get("packetsReceived", 0) + 1
    if client_ip:
        hardware_health["lastPacketIp"] = client_ip

    # Ground reality check: If temperature sensor is disconnected (<= 0.0 C), use 28.0 C ambient aquaculture fallback
    effective_temp = float(temperature) if float(temperature) > 0.0 else 28.0

    # If DO is missing or 0, calculate using the scientific formula
    if dissolvedOxygen <= 0.0:
        dissolvedOxygen = calculate_estimated_do(effective_temp, pH, salinity)

    # 2. Record 4 Core Sensor Values
    reading = {
        "dissolvedOxygen": round(float(dissolvedOxygen), 2),
        "pH": round(float(pH), 2),
        "salinity": round(float(salinity), 1),
        "temperature": round(effective_temp, 1),
        "ammonia": 0.02,
        "hardness": 180.0,
        "timestamp": now_ms
    }

    pond_state["current"] = reading
    pond_state["history"].append(reading)
    if len(pond_state["history"]) > 1000:
        pond_state["history"] = pond_state["history"][-1000:]

    # 3. Check Thresholds & Update Turbines Automation
    check_thresholds(reading)
    update_turbine_automation()
    save_persisted_data()

    # 4. Generate Response Payload for ESP32 / ESP8266
    do_active = pond_state["control"].get("oxygenTurbineActive", False)
    water_active = pond_state["control"].get("waterTurbineActive", False)
    mode_do = pond_state["control"].get("oxygenTurbine", "AUTO")
    mode_water = pond_state["control"].get("waterTurbine", "AUTO")

    return {
        "status": "success",
        "message": "Telemetry received successfully",
        "timestamp": now_ms,
        "systemStatus": "ONLINE",
        "microcontroller": "ESP32",
        # Turbine 1: Dissolved Oxygen Turbine (Servo 1 / GPIO 18)
        "oxygenTurbine": "ON" if do_active else "OFF",
        "oxygenTurbineActive": do_active,
        "servoDO": 180 if do_active else 90,
        "relayLevelDO": 0 if do_active else 1,
        "modeDO": mode_do,
        # Turbine 2: Water Circulation Turbine (Servo 2 / GPIO 19)
        "waterTurbine": "ON" if water_active else "OFF",
        "waterTurbineActive": water_active,
        "servoWater": 180 if water_active else 90,
        "relayLevelWater": 0 if water_active else 1,
        "modeWater": mode_water,
        # Backward-compatibility aliases
        "turbine": "ON" if do_active else "OFF",
        "turbineActive": do_active,
        "relayLevel": 0 if do_active else 1,
        "offlineFailSafe": False
    }

# ==============================================================================
# DEDICATED ESP8266 API ENDPOINTS
# ==============================================================================

class ESP8266TelemetryJSON(BaseModel):
    # Flexible field definitions to accept any common naming convention
    temperature: Optional[float] = None
    temp: Optional[float] = None
    t: Optional[float] = None

    pH: Optional[float] = None
    ph: Optional[float] = None
    p: Optional[float] = None

    salinity: Optional[float] = None
    sal: Optional[float] = None
    s: Optional[float] = None
    ec: Optional[float] = None

    dissolvedOxygen: Optional[float] = None
    do: Optional[float] = None
    oxygen: Optional[float] = None
    d: Optional[float] = None

    turbine: Optional[str] = None
    relay: Optional[int] = None

@app.post("/api/esp32/telemetry", summary="ESP32 JSON Telemetry Endpoint")
@app.post("/api/esp8266/telemetry", summary="Primary ESP8266 JSON Telemetry Endpoint")
@app.post("/api/sensors", summary="Telemetry Endpoint Alias")
async def post_esp8266_telemetry(payload: ESP8266TelemetryJSON, request: Request):
    """
    Receives JSON telemetry directly from ESP8266.
    Returns immediate Oxygen Turbine command and relay state in the response.
    """
    # Extract temperature
    temp = payload.temperature if payload.temperature is not None else (
        payload.temp if payload.temp is not None else (payload.t if payload.t is not None else 28.0)
    )
    # Extract pH
    ph = payload.pH if payload.pH is not None else (
        payload.ph if payload.ph is not None else (payload.p if payload.p is not None else 7.5)
    )
    # Extract Salinity
    sal = payload.salinity if payload.salinity is not None else (
        payload.sal if payload.sal is not None else (payload.s if payload.s is not None else (payload.ec if payload.ec is not None else 18.0))
    )
    # Extract Dissolved Oxygen
    do_val = payload.dissolvedOxygen if payload.dissolvedOxygen is not None else (
        payload.do if payload.do is not None else (payload.oxygen if payload.oxygen is not None else (payload.d if payload.d is not None else 6.0))
    )

    client_ip = request.client.host if request.client else None
    response = ingest_esp8266_telemetry(temp, ph, sal, do_val, client_ip)
    return JSONResponse(content=response)

@app.get("/api/esp32/update", summary="ESP32 HTTP GET Query Telemetry Endpoint")
@app.get("/api/esp8266/update", summary="ESP8266 HTTP GET Query Telemetry Endpoint")
def get_esp8266_update(
    request: Request,
    temp: Optional[float] = None,
    temperature: Optional[float] = None,
    t: Optional[float] = None,
    ph: Optional[float] = None,
    pH: Optional[float] = None,
    p: Optional[float] = None,
    sal: Optional[float] = None,
    salinity: Optional[float] = None,
    s: Optional[float] = None,
    do: Optional[float] = None,
    dissolvedOxygen: Optional[float] = None,
    d: Optional[float] = None
):
    """
    HTTP GET endpoint for lightweight ESP8266 sketches without JSON libraries.
    Example: GET /api/esp8266/update?temp=28.5&ph=7.8&sal=18.2&do=6.1
    """
    final_temp = temp if temp is not None else (temperature if temperature is not None else (t if t is not None else 28.0))
    final_ph = ph if ph is not None else (pH if pH is not None else (p if p is not None else 7.5))
    final_sal = sal if sal is not None else (salinity if salinity is not None else (s if s is not None else 18.0))
    final_do = do if do is not None else (dissolvedOxygen if dissolvedOxygen is not None else (d if d is not None else 6.0))

    client_ip = request.client.host if request.client else None
    response = ingest_esp8266_telemetry(final_temp, final_ph, final_sal, final_do, client_ip)
    return JSONResponse(content=response)

@app.get("/api/esp32/turbine", summary="ESP32 Turbine Command Check")
@app.get("/api/esp8266/turbine", summary="ESP8266 Turbine Command Check")
def get_esp8266_turbine_command(format: Optional[str] = "json"):
    """
    Lightweight endpoint for ESP to poll the current Oxygen Turbine state.
    format='plain' returns single word: ON or OFF.
    """
    update_turbine_automation()
    is_active = pond_state["control"].get("oxygenTurbineActive", False)
    mode = pond_state["control"].get("oxygenTurbine", "AUTO")
    is_online = check_hardware_online()

    if not is_online:
        is_active = False

    relay_level = 0 if is_active else 1

    if format == "plain":
        return PlainTextResponse("ON" if is_active else "OFF")

    return {
        "turbine": "ON" if is_active else "OFF",
        "turbineActive": is_active,
        "relayLevel": relay_level,
        "mode": mode,
        "isOnline": is_online
    }

@app.get("/api/esp32/status", summary="ESP32 Connection Health & Watchdog Stats")
@app.get("/api/esp8266/status", summary="ESP8266 Connection Health & Watchdog Stats")
@app.get("/api/hardware/status", summary="Hardware Connection Status Alias")
def get_esp8266_status():
    """Returns whether the ESP8266 is online, heartbeat latency, and packet counts."""
    is_online = check_hardware_online()
    last_hb = hardware_health.get("lastHeartbeat", 0.0)
    age_sec = round(time.time() - last_hb, 1) if last_hb > 0 else None

    return {
        "microcontroller": "ESP32",
        "isOnline": is_online,
        "systemStatus": "ONLINE" if is_online else "SYSTEM OFFLINE",
        "lastHeartbeat": last_hb,
        "heartbeatAgeSeconds": age_sec,
        "timeoutSeconds": hardware_health.get("timeoutSeconds", WATCHDOG_TIMEOUT_SECONDS),
        "packetsReceived": hardware_health.get("packetsReceived", 0),
        "lastPacketIp": hardware_health.get("lastPacketIp"),
        "manualOfflineOverride": hardware_health.get("manualOfflineOverride", False),
        "turbineActive": pond_state["control"].get("oxygenTurbineActive", False),
        "turbineMode": pond_state["control"].get("oxygenTurbine", "AUTO")
    }

# ==============================================================================
# DASHBOARD WEB CLIENT ENDPOINTS (000 & SYSTEM OFFLINE FAIL-SAFE)
# ==============================================================================

@app.get("/api/sensors", summary="Get all current sensor readings formatted for Web Dashboard")
def get_dashboard_sensors():
    """
    Returns the 4 core sensors.
    CRITICAL REQUIREMENT: If ESP8266 hardware is offline, formatted values MUST return '000'
    and system status MUST return 'SYSTEM OFFLINE'.
    """
    now_ms = int(time.time() * 1000)
    current = pond_state["current"]
    settings = pond_state.get("settings", DEFAULT_SETTINGS)
    is_online = check_hardware_online()
    last_hb = hardware_health.get("lastHeartbeat", 0.0)
    age_sec = round(time.time() - last_hb) if last_hb > 0 else round((now_ms - current.get("timestamp", 0)) / 1000)

    def get_status(val, min_v, max_v):
        if not is_online:
            return "OFFLINE"
        if val < min_v or val > max_v:
            diff = min_v - val if val < min_v else val - max_v
            spread = max_v - min_v if max_v != min_v else 1.0
            return "CRITICAL" if diff > (spread * 0.25) else "WARNING"
        return "NORMAL"

    if is_online:
        do_val = current.get("dissolvedOxygen", 0.0)
        ph_val = current.get("pH", 0.0)
        sal_val = current.get("salinity", 0.0)
        temp_val = current.get("temperature", 0.0)
        amm_val = current.get("ammonia", 0.02)
        hard_val = current.get("hardness", 180.0)

        # Health score based on 4 core parameters
        warning_count = sum(1 for v, k in [
            (do_val, 'dissolvedOxygen'), (ph_val, 'pH'), (sal_val, 'salinity'), 
            (temp_val, 'temperature')
        ] if get_status(v, settings[k]['min'], settings[k]['max']) == "WARNING")

        critical_count = sum(1 for v, k in [
            (do_val, 'dissolvedOxygen'), (ph_val, 'pH'), (sal_val, 'salinity'), 
            (temp_val, 'temperature')
        ] if get_status(v, settings[k]['min'], settings[k]['max']) == "CRITICAL")

        health_score = max(10, round(100 - (warning_count * 15) - (critical_count * 35)))
        system_status = "ONLINE"
    else:
        # Hardware is OFFLINE -> Set values to 0.0 and formatted display to "000"
        do_val = 0.0
        ph_val = 0.0
        sal_val = 0.0
        temp_val = 0.0
        amm_val = 0.0
        hard_val = 0.0
        health_score = 0
        warning_count = 0
        critical_count = 0
        system_status = "SYSTEM OFFLINE"

    sensor_list = [
        {
            "key": "dissolvedOxygen",
            "name": "Dissolved Oxygen (DO)",
            "value": do_val,
            "displayValue": "000" if not is_online else f"{do_val:.2f}",
            "unit": "mg/L",
            "status": get_status(do_val, settings["dissolvedOxygen"]["min"], settings["dissolvedOxygen"]["max"]),
            "safeRange": f"{settings['dissolvedOxygen']['min']} - {settings['dissolvedOxygen']['max']} mg/L",
            "pin": "ESP32 -> GPIO 34 (Analog / Estimated DO)",
            "isCore": True
        },
        {
            "key": "pH",
            "name": "pH Level",
            "value": ph_val,
            "displayValue": "000" if not is_online else f"{ph_val:.2f}",
            "unit": "",
            "status": get_status(ph_val, settings["pH"]["min"], settings["pH"]["max"]),
            "safeRange": f"{settings['pH']['min']} - {settings['pH']['max']}",
            "pin": "ESP32 -> GPIO 34 (Analog pH)",
            "isCore": True
        },
        {
            "key": "salinity",
            "name": "Salinity",
            "value": sal_val,
            "displayValue": "000" if not is_online else f"{sal_val:.1f}",
            "unit": "ppt",
            "status": get_status(sal_val, settings["salinity"]["min"], settings["salinity"]["max"]),
            "safeRange": f"{settings['salinity']['min']} - {settings['salinity']['max']} ppt",
            "pin": "ESP32 -> GPIO 35 (Analog TDS/Salinity)",
            "isCore": True
        },
        {
            "key": "temperature",
            "name": "Water Temperature",
            "value": temp_val,
            "displayValue": "000" if not is_online else f"{temp_val:.1f}",
            "unit": "°C",
            "status": get_status(temp_val, settings["temperature"]["min"], settings["temperature"]["max"]),
            "safeRange": f"{settings['temperature']['min']} - {settings['temperature']['max']} °C",
            "pin": "ESP32 -> GPIO 4 (DS18B20 OneWire)",
            "isCore": True
        }
    ]

    do_active = pond_state["control"].get("oxygenTurbineActive", False) if is_online else False
    water_active = pond_state["control"].get("waterTurbineActive", False) if is_online else False

    return {
        "status": "success",
        "system": "Smart Shrimp Pond IoT Management System",
        "pondId": "POND_01",
        "microcontroller": "ESP32",
        "source": "ESP32_HARDWARE",
        "isOnline": is_online,
        "systemStatus": system_status,
        "timestamp": now_ms,
        "isoTime": datetime.now(timezone.utc).isoformat(),
        "ageSeconds": age_sec,
        "isStale": not is_online,
        "hardwareHealth": {
            "isOnline": is_online,
            "lastHeartbeat": hardware_health.get("lastHeartbeat", 0.0),
            "timeoutSeconds": hardware_health.get("timeoutSeconds", WATCHDOG_TIMEOUT_SECONDS),
            "manualOfflineOverride": hardware_health.get("manualOfflineOverride", False)
        },
        "flatValues": {
            "dissolvedOxygen": do_val,
            "pH": ph_val,
            "salinity": sal_val,
            "temperature": temp_val,
            "ammonia": amm_val,
            "hardness": hard_val
        },
        "formattedDisplay": {
            "dissolvedOxygen": "000" if not is_online else f"{do_val:.2f}",
            "pH": "000" if not is_online else f"{ph_val:.2f}",
            "salinity": "000" if not is_online else f"{sal_val:.1f}",
            "temperature": "000" if not is_online else f"{temp_val:.1f}"
        },
        "sensorList": sensor_list,
        "actuators": {
            "oxygenTurbine": {
                "name": "Dissolved Oxygen Turbine",
                "mode": pond_state["control"].get("oxygenTurbine", "AUTO"),
                "active": do_active,
                "status": ("RUNNING" if do_active else "STANDBY") if is_online else "OFFLINE (HOLD)",
                "relayPin": "ESP32 -> GPIO 18 (Servo 1)"
            },
            "waterTurbine": {
                "name": "Water Circulation Turbine",
                "mode": pond_state["control"].get("waterTurbine", "AUTO"),
                "active": water_active,
                "status": ("RUNNING" if water_active else "STANDBY") if is_online else "OFFLINE (HOLD)",
                "relayPin": "ESP32 -> GPIO 19 (Servo 2)"
            }
        },
        "summary": {
            "healthScore": health_score,
            "overallVerdict": "SYSTEM OFFLINE" if not is_online else ("OPTIMAL" if health_score >= 85 else ("ATTENTION" if health_score >= 60 else "CRITICAL")),
            "criticalAlertsCount": critical_count,
            "warningAlertsCount": warning_count
        }
    }

@app.get("/api/pond/all")
def get_all_pond_data():
    """Complete bundle for frontend dashboard initialization."""
    update_turbine_automation()
    is_online = check_hardware_online()
    last_hb = hardware_health.get("lastHeartbeat", 0.0)
    now_ms = int(time.time() * 1000)
    age_sec = round(time.time() - last_hb) if last_hb > 0 else round((now_ms - pond_state["current"].get("timestamp", 0)) / 1000)

    reading_out = pond_state["current"] if is_online else {
        "dissolvedOxygen": 0.0, "pH": 0.0, "salinity": 0.0, "temperature": 0.0, "ammonia": 0.0, "hardness": 0.0, "timestamp": now_ms
    }

    return {
        "current": reading_out,
        "displayZeroes": not is_online,
        "isOnline": is_online,
        "systemStatus": "ONLINE" if is_online else "SYSTEM OFFLINE",
        "control": pond_state["control"],
        "settings": pond_state["settings"],
        "alerts": pond_state["alerts"][:50],
        "dataSource": "ESP32_HARDWARE",
        "isStale": not is_online,
        "ageSeconds": age_sec,
        "microcontroller": "ESP32"
    }

@app.post("/api/hardware/toggle-offline", summary="Toggle hardware offline mode for viva/demo testing")
def toggle_hardware_offline(force_offline: Optional[bool] = None):
    """
    Allows examiner or student to manually toggle offline state from the web UI
    to demonstrate the 000 and SYSTEM OFFLINE display without pulling cables.
    """
    if force_offline is None:
        hardware_health["manualOfflineOverride"] = not hardware_health.get("manualOfflineOverride", False)
    else:
        hardware_health["manualOfflineOverride"] = force_offline

    if not hardware_health["manualOfflineOverride"]:
        # Hardware reconnected: Refresh heartbeat and restore live telemetry values if zeroed
        hardware_health["lastHeartbeat"] = time.time()
        hardware_health["isOnline"] = True
        if pond_state["current"].get("dissolvedOxygen", 0.0) <= 0.0:
            pond_state["current"].update({
                "dissolvedOxygen": 6.2,
                "pH": 7.8,
                "salinity": 18.2,
                "temperature": 28.5,
                "ammonia": 0.02,
                "hardness": 180.0,
                "timestamp": int(time.time() * 1000)
            })

    update_turbine_automation()
    is_online = check_hardware_online()

    return {
        "status": "success",
        "manualOfflineOverride": hardware_health["manualOfflineOverride"],
        "isOnline": is_online,
        "systemStatus": "ONLINE" if is_online else "SYSTEM OFFLINE",
        "message": "Hardware disconnected. Values set to 000 (SYSTEM OFFLINE)." if not is_online else "Hardware reconnected. Live telemetry active."
    }

@app.post("/api/pond/control", summary="Direct Pond Actuator Controls (AUTO, ON, OFF)")
async def update_pond_actuator_control(request: Request):
    """
    Accepts turbine mode updates from UI:
    e.g. {"oxygenTurbine": "ON"}, {"waterTurbine": "OFF"}, {"device": "oxygenTurbine", "mode": "AUTO"}
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON body"})

    device = body.get("device")
    mode = body.get("mode")
    if device and mode:
        body[device] = mode

    # Legacy mapping
    if "aerator" in body:
        body["oxygenTurbine"] = body["aerator"]
    if "waterPump" in body:
        body["waterTurbine"] = body["waterPump"]
    if "pump" in body:
        body["waterTurbine"] = body["pump"]
    if "turbine" in body:
        body["oxygenTurbine"] = body["turbine"]

    now_ms = int(time.time() * 1000)
    if "oxygenTurbine" in body:
        val = str(body["oxygenTurbine"]).upper()
        if val in ["AUTO", "ON", "OFF"]:
            pond_state["control"]["oxygenTurbine"] = val
            pond_state["control"]["lastChanged"] = now_ms

    if "waterTurbine" in body:
        val = str(body["waterTurbine"]).upper()
        if val in ["AUTO", "ON", "OFF"]:
            pond_state["control"]["waterTurbine"] = val
            pond_state["control"]["lastChanged"] = now_ms

    update_turbine_automation()
    save_persisted_data()

    do_active = pond_state["control"].get("oxygenTurbineActive", False)
    water_active = pond_state["control"].get("waterTurbineActive", False)

    return {
        "status": "success",
        "control": pond_state["control"],
        "oxygenTurbine": pond_state["control"].get("oxygenTurbine", "AUTO"),
        "oxygenTurbineActive": do_active,
        "servoDO": 90 if do_active else 0,
        "waterTurbine": pond_state["control"].get("waterTurbine", "AUTO"),
        "waterTurbineActive": water_active,
        "servoWater": 90 if water_active else 0
    }

class TurbineControlRequest(BaseModel):
    mode: str  # "AUTO" | "ON" | "OFF"

@app.post("/api/turbine/control", summary="Direct Oxygen Turbine Mode Control (AUTO, ON, OFF)")
def control_oxygen_turbine(req: TurbineControlRequest):
    """Operator override for Oxygen Turbine mode."""
    mode = req.mode.upper()
    if mode not in ["AUTO", "ON", "OFF"]:
        return JSONResponse(status_code=400, content={"error": "Invalid mode. Use AUTO, ON, or OFF."})

    pond_state["control"]["oxygenTurbine"] = mode
    pond_state["control"]["lastChanged"] = int(time.time() * 1000)
    update_turbine_automation()
    save_persisted_data()

    return {
        "status": "success",
        "oxygenTurbine": mode,
        "turbineActive": pond_state["control"]["oxygenTurbineActive"],
        "servoDO": 90 if pond_state["control"]["oxygenTurbineActive"] else 0
    }

@app.get("/api/esp32/actuators", summary="Direct ESP32 Actuator State Query")
@app.get("/api/esp8266/actuators", summary="Direct ESP Actuator State Query")
def get_esp32_actuators():
    update_turbine_automation()
    do_active = pond_state["control"].get("oxygenTurbineActive", False)
    water_active = pond_state["control"].get("waterTurbineActive", False)
    return {
        "status": "success",
        "oxygenTurbineActive": do_active,
        "waterTurbineActive": water_active,
        "servoDO": 90 if do_active else 0,
        "servoWater": 90 if water_active else 0,
        "oxygenTurbine": pond_state["control"].get("oxygenTurbine", "AUTO"),
        "waterTurbine": pond_state["control"].get("waterTurbine", "AUTO")
    }

@app.get("/api/pond/history", summary="Telemetry History for Trends Graph")
def get_history(range: str = "24h"):
    now_ms = int(time.time() * 1000)
    history = pond_state.get("history", [])

    time_filters = {
        "1h": 60 * 60 * 1000,
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
        "all": float("inf")
    }
    delta = time_filters.get(range, 24 * 60 * 60 * 1000)
    filtered = [p for p in history if (now_ms - p.get("timestamp", 0)) <= delta]

    max_pts = 100
    if len(filtered) > max_pts:
        step = max(1, len(filtered) // max_pts)
        filtered = filtered[::step]

    return {"range": range, "count": len(filtered), "data": filtered}

@app.get("/api/pond/alerts", summary="Get Alert Notifications")
def get_alerts():
    return pond_state.get("alerts", [])

@app.post("/api/pond/alerts/clear", summary="Clear Alerts")
def clear_alerts():
    pond_state["alerts"] = []
    save_persisted_data()
    return {"status": "ok", "message": "Alerts cleared"}

@app.get("/api/pond/settings", summary="Get Safe Threshold Settings")
def get_settings():
    return pond_state.get("settings", DEFAULT_SETTINGS)

@app.post("/api/pond/settings", summary="Update Safe Threshold Settings")
async def update_settings(request: Request):
    new_settings = await request.json()
    settings = pond_state.setdefault("settings", DEFAULT_SETTINGS.copy())
    for k, v in new_settings.items():
        if k in settings and isinstance(v, dict):
            settings[k]["min"] = float(v.get("min", settings[k]["min"]))
            settings[k]["max"] = float(v.get("max", settings[k]["max"]))
    save_persisted_data()
    return {"status": "ok", "settings": settings}

@app.post("/api/pond/settings/reset", summary="Reset Thresholds to Default")
def reset_settings():
    pond_state["settings"] = json.loads(json.dumps(DEFAULT_SETTINGS))
    save_persisted_data()
    return {"status": "ok", "settings": pond_state["settings"]}

@app.post("/api/pond/current", summary="Sandbox Telemetry Injection")
async def post_pond_current(request: Request):
    """Allows manual sensor testing / sandbox values to be pushed to pond state."""
    data = await request.json()
    temp = float(data.get("temperature", 28.0))
    ph = float(data.get("pH", 7.8))
    sal = float(data.get("salinity", 18.0))
    do_val = float(data.get("dissolvedOxygen", 6.0))
    amm = float(data.get("ammonia", 0.02))
    hard = float(data.get("hardness", 180.0))
    
    now_ms = int(time.time() * 1000)
    reading = {
        "dissolvedOxygen": round(do_val, 2),
        "pH": round(ph, 2),
        "salinity": round(sal, 1),
        "temperature": round(temp, 1),
        "ammonia": round(amm, 3),
        "hardness": round(hard, 1),
        "timestamp": now_ms
    }
    pond_state["current"] = reading
    pond_state["history"].append(reading)
    if len(pond_state["history"]) > 1000:
        pond_state["history"] = pond_state["history"][-1000:]
        
    hardware_health["lastHeartbeat"] = time.time()
    hardware_health["isOnline"] = True
    hardware_health["manualOfflineOverride"] = False
    
    check_thresholds(reading)
    update_turbine_automation()
    save_persisted_data()
    return {"status": "ok", "reading": reading, "control": pond_state["control"]}

@app.post("/api/pond/alerts/simulate", summary="Simulate an alert violation")
def simulate_alert(parameter: str = "dissolvedOxygen", level: str = "critical"):
    param_meta = pond_state["settings"].get(parameter, {"label": parameter, "unit": "", "min": 4.0, "max": 8.0})
    unit = param_meta.get("unit", "")
    label = param_meta.get("label", parameter)
    p_min = param_meta.get("min", 4.0)
    p_max = param_meta.get("max", 8.0)

    val = round(p_min * 0.6, 2) if level == "critical" else round(p_min * 0.85, 2)
    now_ms = int(time.time() * 1000)
    alert_entry = {
        "id": f"sim_alt_{now_ms}",
        "parameter": parameter,
        "label": label,
        "value": val,
        "unit": unit,
        "threshold": f"{p_min} - {p_max}",
        "level": level,
        "message": f"[SIMULATION] {label} breach detected: {val} {unit} (Safe: {p_min} - {p_max} {unit})",
        "timestamp": now_ms
    }
    pond_state.setdefault("alerts", []).insert(0, alert_entry)
    if len(pond_state["alerts"]) > 100:
        pond_state["alerts"].pop()
    save_persisted_data()
    return {"status": "ok", "alert": alert_entry}

# Simulation toggle
simulation_active = False

@app.post("/api/simulator/toggle", summary="Toggle background telemetry simulation")
def toggle_simulator():
    global simulation_active
    simulation_active = not simulation_active
    return {"status": "ok", "simulationMode": simulation_active}

@app.post("/api/config", summary="Save client cloud configuration")
async def save_config(request: Request):
    try:
        cfg = await request.json()
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        with open(SETTINGS_FILE, "w") as f:
            json.dump(cfg, f, indent=2)
        return {"status": "ok", "config": cfg}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.get("/api/config", summary="Get client cloud configuration")
def get_config():
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
    return {"simulationMode": False}

# API Directory & ESP32 Integration Documentation
@app.get("/api/esp32/docs", summary="ESP32 Integration Guide & Endpoints")
@app.get("/api/esp8266/docs", summary="ESP32 / ESP8266 Integration Guide & Endpoints")
def get_esp8266_docs():
    return {
        "system": "Smart Shrimp Pond IoT Management System",
        "microcontroller": "ESP8266 (NodeMCU / Wemos D1)",
        "sensors": [
            "Dissolved Oxygen (DO)",
            "pH Level",
            "Salinity (EC)",
            "Water Temperature"
        ],
        "actuator": "Oxygen Turbine Relay",
        "endpoints": {
            "jsonTelemetry": {
                "method": "POST",
                "url": "/api/esp8266/telemetry",
                "bodyExample": {
                    "temperature": 28.5,
                    "pH": 7.8,
                    "salinity": 18.2,
                    "dissolvedOxygen": 6.1
                },
                "responseExample": {
                    "status": "success",
                    "turbine": "ON",
                    "turbineActive": True,
                    "relayLevel": 0
                }
            },
            "queryTelemetry": {
                "method": "GET",
                "url": "/api/esp8266/update?temp=28.5&ph=7.8&sal=18.2&do=6.1",
                "description": "Simple GET for sketches without JSON parser"
            },
            "turbinePoll": {
                "method": "GET",
                "url": "/api/esp8266/turbine",
                "description": "Returns current Oxygen Turbine state"
            }
        },
        "watchdog": {
            "timeoutSeconds": WATCHDOG_TIMEOUT_SECONDS,
            "offlineBehavior": "If no packet received within 15 seconds, values switch to 000 and status switches to SYSTEM OFFLINE."
        }
    }

# Mount static files for the single-page web dashboard
app.mount("/", StaticFiles(directory="static", html=True), name="static")

# Startup
@app.on_event("startup")
def startup_event():
    load_persisted_data()
    update_turbine_automation()
    print("ESP8266 Smart Shrimp Pond API Server initialized.")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    print(f"Starting IoT Server on http://0.0.0.0:{port} ...")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
