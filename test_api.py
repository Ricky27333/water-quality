import requests
import json
import time
import random

# The URL of your local FastAPI server
# Make sure app.py is running on port 8000!
API_URL = "http://localhost:8000/api/esp32/telemetry"

def simulate_esp32():
    print(f"Simulating ESP32 sending JSON data to {API_URL}...\n")
    
    # Generate some realistic simulated sensor data
    payload = {
        "temperature": round(random.uniform(28.0, 31.0), 1),
        "pH": round(random.uniform(7.0, 8.2), 2),
        "salinity": round(random.uniform(15.0, 20.0), 1),
        "dissolvedOxygen": round(random.uniform(3.5, 6.5), 2)
    }
    
    print(f"Sending JSON Payload: {json.dumps(payload, indent=2)}")
    
    try:
        # Send the POST request to the API (Mediator)
        response = requests.post(API_URL, json=payload)
        
        # Check if the request was successful
        if response.status_code == 200:
            print(f"\nSuccess! API Response: {json.dumps(response.json(), indent=2)}")
            print("\nThe API is working correctly as a mediator and has responded with the Oxygen Turbine command!")
        else:
            print(f"\nError: Received status code {response.status_code}")
            print(response.text)
            
    except requests.exceptions.ConnectionError:
        print("\nERROR: Failed to connect to the API.")
        print("Please make sure you are running 'python app.py' in a separate terminal before running this test script!")

if __name__ == "__main__":
    simulate_esp32()
