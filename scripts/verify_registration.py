import requests
import json
import time

def test_registration(payload, description):
    print(f"Testing: {description}")
    try:
        response = requests.post('http://localhost:5000/api/leads', json=payload)
        print(f"Status: {response.status_code}")
        print(f"Response: {json.dumps(response.json(), indent=2)}")
        print("-" * 30)
    except Exception as e:
        print(f"Error: {e}")

def run_tests():
    base = {"firstName": "Test", "lastName": "User", "password": "password123"}
    timestamp = int(time.time())

    test_registration({**base, "email": f"test{timestamp}@example.com"}, "Valid Email, No Phone")
    test_registration({**base, "phone": "555-0101"}, "Valid Phone, No Email")
    test_registration({**base, "email": f"test{timestamp+1}@example.com", "phone": "555-0202"}, "Both Email and Phone")
    test_registration({**base}, "Neither Email nor Phone (Should Fail)")

if __name__ == "__main__":
    run_tests()
