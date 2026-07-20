import fetch from "node-fetch";

async function testQfxApi() {
  console.log("Testing QFX quick-book API...");
  try {
    // We will use the hardcoded token from the main script for the test
    const token = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbiI6IjBmZDc1OWM2LTczMTYtNDdlZi1iZmYyLTg3ZWYwNTYxYWUxMCIsImlhdCI6MTc2MDQ3MDMzMX0.wkfUdwL5dZB3iPf_JeaLNI1GvtzqAXBntuu1AAtkwLk";
    
    const response = await fetch("https://web-api.qfxcinemas.com/api/external/quick-book", {
      method: "POST",
      headers: {
          "content-type": "application/json",
          "authorization": token,
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
        console.error(`Request failed with status: ${response.status} ${response.statusText}`);
        const text = await response.text();
        console.error(`Response text: ${text}`);
        return;
    }

    const data = await response.json();
    console.log("Response structure keys:", Object.keys(data));
    
    if (data.movies && data.movies.length > 0) {
        const movieId = data.movies[0].movie_id;
        const targetDate = new Date().toISOString().split("T")[0];
        console.log(`\nTesting showtimes API for movie ${movieId} on ${targetDate}...`);
        
        const showtimesRes = await fetch(`https://web-api.qfxcinemas.com/api/cinema/admin/movie-confirmed-list/${movieId}?fromDate=${targetDate}&city_id=29790`, {
            headers: { "authorization": token }
        });
        
        if (!showtimesRes.ok) {
            console.error(`Showtimes API failed: ${showtimesRes.status}`);
        } else {
            const showData = await showtimesRes.json();
            console.log("Showtimes response keys:", Object.keys(showData));
            if (showData.Records) {
                let records = Array.isArray(showData.Records) ? showData.Records : (showData.Records.data || []);
                console.log(`Found ${records.length} records.`);
                if (records.length > 0) {
                    console.log("First record keys:", Object.keys(records[0]));
                    console.log("First record sample:", JSON.stringify(records[0], null, 2));
                }
            } else {
                console.log("No 'Records' in showData:", JSON.stringify(showData).substring(0, 500));
            }
        }
    }

  } catch (err) {
    console.error("Fetch error:", err.message);
  }
}

testQfxApi();
