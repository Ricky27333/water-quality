import urllib.request
import json
import time

BASE_URL = "http://127.0.0.1:8000"

def thunder_request(method, endpoint, body=None, description=""):
    url = f"{BASE_URL}{endpoint}"
    headers = {"Content-Type": "application/json", "User-Agent": "ThunderClient/1.2"} if body else {"User-Agent": "ThunderClient/1.2"}
    data = json.dumps(body).encode("utf-8") if body else None
    
    print("\n" + "="*70)
    print(f"[THUNDER CLIENT] [{method}] {endpoint}")
    if description:
        print(f"   Description : {description}")
    if body:
        print(f"   Payload     : {json.dumps(body)}")
    print("-" * 70)
    
    t0 = time.time()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            elapsed_ms = round((time.time() - t0) * 1000, 1)
            raw = res.read().decode("utf-8")
            status = res.status
            try:
                parsed = json.loads(raw)
                pretty_body = json.dumps(parsed, indent=2)
            except Exception:
                pretty_body = raw
            
            print(f"   Status Code : {status} OK  ({elapsed_ms} ms)")
            print(f"   Response Body:")
            for line in pretty_body.splitlines()[:25]:
                print(f"      {line}")
            if len(pretty_body.splitlines()) > 25:
                print("      ... [truncated for display]")
            print(f"   Result      : [PASSED] 200 OK")
            return True, parsed
    except urllib.error.HTTPError as e:
        elapsed_ms = round((time.time() - t0) * 1000, 1)
        err_body = e.read().decode('utf-8')
        print(f"   Status Code : {e.code} ({elapsed_ms} ms)")
        print(f"   Error Body  : {err_body}")
        print(f"   Result      : [FAILED]")
        return False, None
    except Exception as e:
        print(f"   Exception   : {str(e)}")
        print(f"   Result      : [ERROR]")
        return False, None

def run_all_thunder_tests():
    print("\n" + "#"*70)
    print("   THUNDER CLIENT AUTOMATED API TEST RUNNER - ESP32 SMART POND")
    print("#"*70)
    
    results = []

    # 1. GET /api/sensors (Before telemetry - check offline watchdog)
    ok, res = thunder_request("GET", "/api/sensors", description="Check sensors status & formatted display")
    results.append(("GET /api/sensors", ok))

    # 2. GET /api/pond/all (Full initialization state)
    ok, res = thunder_request("GET", "/api/pond/all", description="Dashboard complete initialization bundle")
    results.append(("GET /api/pond/all", ok))

    # 3. POST /api/esp32/telemetry (Simulate ESP32 sending real sensor values)
    esp32_payload = {
        "temperature": 28.4,
        "ph": 7.82,
        "tds": 350.5,
        "salinity": 18.2,
        "do": 6.15,
        "water_quality": "OPTIMAL",
        "oxygenTurbineActive": False,
        "waterTurbineActive": False
    }
    ok, res = thunder_request("POST", "/api/esp32/telemetry", body=esp32_payload, description="ESP32 Telemetry Ingestion with Actuator Feedback")
    results.append(("POST /api/esp32/telemetry", ok))

    # 4. GET /api/sensors (After telemetry - verify status is ONLINE and values display live)
    ok, res = thunder_request("GET", "/api/sensors", description="Verify sensors updated to ONLINE with live sensor readings")
    is_online = res.get("isOnline") if res else False
    results.append(("GET /api/sensors (ONLINE verify)", ok and is_online))

    # 5. GET /api/esp32/actuators (Microcontroller polling endpoint)
    ok, res = thunder_request("GET", "/api/esp32/actuators", description="ESP32 actuator state poll (DO Turbine & Water Circulation Turbine)")
    results.append(("GET /api/esp32/actuators", ok))

    # 6. GET /api/esp32/status (Hardware Watchdog diagnostic)
    ok, res = thunder_request("GET", "/api/esp32/status", description="ESP32 connection health, packets received, & heartbeat latency")
    results.append(("GET /api/esp32/status", ok))

    # 7. POST /api/pond/control (Operator toggles Turbines to ON)
    control_payload = {"oxygenTurbine": "ON", "waterTurbine": "ON"}
    ok, res = thunder_request("POST", "/api/pond/control", body=control_payload, description="Operator override: Turn ON DO Turbine and Water Turbine")
    do_on = res.get("oxygenTurbineActive") if res else False
    results.append(("POST /api/pond/control (Turn ON)", ok and do_on))

    # 8. POST /api/pond/control (Operator reverts Turbines to AUTO)
    control_auto = {"oxygenTurbine": "AUTO", "waterTurbine": "AUTO"}
    ok, res = thunder_request("POST", "/api/pond/control", body=control_auto, description="Operator override: Revert Turbines to AUTO mode")
    results.append(("POST /api/pond/control (Revert AUTO)", ok))

    # 9. GET /api/pond/settings (Threshold configuration)
    ok, res = thunder_request("GET", "/api/pond/settings", description="Get biological safe threshold settings")
    results.append(("GET /api/pond/settings", ok))

    # 10. POST /api/pond/settings (Update thresholds)
    new_settings = {"dissolvedOxygen": {"min": 4.5, "max": 8.5}}
    ok, res = thunder_request("POST", "/api/pond/settings", body=new_settings, description="Update safe threshold limits")
    results.append(("POST /api/pond/settings", ok))

    # 11. POST /api/pond/settings/reset (Reset thresholds)
    ok, res = thunder_request("POST", "/api/pond/settings/reset", description="Reset thresholds to standard Penaeus vannamei biological limits")
    results.append(("POST /api/pond/settings/reset", ok))

    # 12. POST /api/pond/alerts/simulate (Simulate violation alert)
    ok, res = thunder_request("POST", "/api/pond/alerts/simulate?parameter=dissolvedOxygen&level=critical", description="Simulate critical low DO alert trigger")
    results.append(("POST /api/pond/alerts/simulate", ok))

    # 13. GET /api/pond/alerts (Fetch incident log)
    ok, res = thunder_request("GET", "/api/pond/alerts", description="Fetch real-time alerts incident log")
    results.append(("GET /api/pond/alerts", ok))

    # 14. POST /api/pond/alerts/clear (Clear incident log)
    ok, res = thunder_request("POST", "/api/pond/alerts/clear", description="Clear all alerts from log")
    results.append(("POST /api/pond/alerts/clear", ok))

    # 15. POST /api/pond/current (Sensor Sandbox injection)
    sandbox_payload = {
        "temperature": 29.0,
        "pH": 7.9,
        "salinity": 19.5,
        "dissolvedOxygen": 5.8,
        "ammonia": 0.03,
        "hardness": 200.0
    }
    ok, res = thunder_request("POST", "/api/pond/current", body=sandbox_payload, description="Sensor Sandbox: push custom slider values to pond state")
    results.append(("POST /api/pond/current", ok))

    # 16. POST /api/hardware/toggle-offline (Demo failsafe switch)
    ok, res = thunder_request("POST", "/api/hardware/toggle-offline?force_offline=true", description="Examiner viva demo: simulate hardware disconnect (triggers 000)")
    results.append(("POST /api/hardware/toggle-offline (OFFLINE)", ok))

    # Reconnect hardware
    ok, res = thunder_request("POST", "/api/hardware/toggle-offline?force_offline=false", description="Restore live hardware telemetry mode")
    results.append(("POST /api/hardware/toggle-offline (RECONNECT)", ok))

    # 17. GET /api/pond/history (Graph trend data)
    ok, res = thunder_request("GET", "/api/pond/history?range=24h", description="Fetch historical 24h trend data points for ApexCharts")
    results.append(("GET /api/pond/history", ok))

    # 18. GET /api/esp32/docs (API documentation)
    ok, res = thunder_request("GET", "/api/esp32/docs", description="ESP32 integration documentation and JSON schema")
    results.append(("GET /api/esp32/docs", ok))

    print("\n" + "="*70)
    print("THUNDER CLIENT TEST RUN SUMMARY")
    print("="*70)
    passed_count = sum(1 for _, ok in results if ok)
    total_count = len(results)
    for name, ok in results:
        badge = "[PASS]" if ok else "[FAIL]"
        print(f"  {badge}  {name}")
    print("-" * 70)
    print(f"  TOTAL: {passed_count}/{total_count} PASSED ({round(passed_count/total_count*100)}%)")
    print("="*70 + "\n")

if __name__ == "__main__":
    run_all_thunder_tests()
