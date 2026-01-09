const testData = {
    accounts: [
        {
            sfID: "test123",
            name: "Test Account",
            industry: "Technology",
            website: "https://test.com",
            phone: "555-1234",
            address: "123 Test St, Test City, CA 90210"
        }
    ]
};

const jwtToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzZXJ2aWNlIjoic2FsZXNmb3JjZSIsInB1cnBvc2UiOiJhY2NvdW50LXN5bmMiLCJpYXQiOjE3MzQ0MTc5NzAsImV4cCI6MTc2NTk1Mzk3MH0.INChA9t-Z41mFnmLUU1XZtW0roHZbtDObsCcA6nuwS0";

fetch("http://localhost:5000/api/accounts/sync", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${jwtToken}`
    },
    body: JSON.stringify(testData)
})
.then(res => res.json())
.then(data => console.log("Response:", data))
.catch(err => console.error("Error:", err));
