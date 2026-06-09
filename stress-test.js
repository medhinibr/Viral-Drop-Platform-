const readline = require("readline");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const ask = (query) => new Promise((resolve) => rl.question(query, resolve));

async function run() {
    console.log(" Starting Interactive Stress Test Toolkit...\n");

    try {
        // Fetch active campaigns to choose from
        const campaignsRes = await fetch("http://localhost:10000/active-campaign");
        const campaigns = await campaignsRes.json();

        if (campaigns.length === 0) {
            console.log(" No active events found in the database. Please create one on the platform first.");
            process.exit(0);
        }

        // Display list of events
        console.log("=== Available Events inside Database ===");
        campaigns.forEach((c, idx) => {
            const available = c.limit - (c.claimed || 0);
            console.log(`[${idx + 1}] ID: ${c._id} | Title: "${c.title}" | Available: ${available}/${c.limit}`);
        });
        console.log("=======================================\n");

        const selectedInput = await ask(" Enter the number of the event to test (or paste the literal Campaign ID): ");
        let targetCampaign;

        const selectedIdx = parseInt(selectedInput.trim());
        if (!isNaN(selectedIdx) && selectedIdx > 0 && selectedIdx <= campaigns.length) {
            targetCampaign = campaigns[selectedIdx - 1]; // Pick from menu
        } else {
            targetCampaign = campaigns.find(c => c._id === selectedInput.trim()); // Pick exactly by ID
        }

        if (!targetCampaign) {
            console.log("❌ Invalid selection or not found. Exiting.");
            process.exit(1);
        }

        const campaignId = targetCampaign._id;
        const totalSeats = targetCampaign.limit;
        const alreadyClaimed = targetCampaign.claimed || 0;
        const seatsAvailable = totalSeats - alreadyClaimed;

        console.log(`\n🎯 TARGET EVENT: "${targetCampaign.title}"`);
        console.log(`🎫 Event ID:    ${campaignId}`);
        console.log(` Available:    ${seatsAvailable} / ${totalSeats}\n`);

        console.log("=== Select Iteration Limit (Concurrent Requests) ===");
        console.log("1) 10");
        console.log("2) 100");
        console.log("3) 500");
        console.log("4) 1000");
        console.log("5) 2000");
        console.log("6) Enter manually");

        let iterations = 0;
        let iterationChoice = await ask("\n👉 Enter choice (1-6): ");
        
        switch(iterationChoice.trim()) {
            case "1": iterations = 10; break;
            case "2": iterations = 100; break;
            case "3": iterations = 500; break;
            case "4": iterations = 1000; break;
            case "5": iterations = 2000; break;
            case "6": 
                const custom = await ask("⌨️ Enter manual iteration limit: ");
                iterations = parseInt(custom.trim(), 10);
                break;
            default:
                console.log("⚠️ Invalid choice. Defaulting to 10 limit.");
                iterations = 10;
        }

        if (isNaN(iterations) || iterations <= 0) {
            console.log("❌ Invalid iteration limit. Exiting.");
            process.exit(1);
        }

        console.log(`\n🔥 Preparing to fire ${iterations} network requests...`);
        console.log(`⚙️  Intelligently batching requests to prevent Windows OS outgoing socket exhaustion...`);
        console.log(`⏱️ Performance timer started.\n`);

        const startTime = Date.now();
        
        let successCount = 0;
        let failCount = 0;
        let reasons = {};

        // Batch size limits concurrent outgoing TCP connections from the testing script
        const BATCH_SIZE = 300; 

        for (let i = 0; i < iterations; i += BATCH_SIZE) {
            const batch = [];
            const currentBatchSize = Math.min(BATCH_SIZE, iterations - i);

            for (let j = 0; j < currentBatchSize; j++) {
                const reqIdx = i + j + 1;
                const mockUserToken = `test-token-${Date.now()}-${reqIdx}`;
                
                batch.push(
                    // Using 127.0.0.1 instead of localhost prevents Windows DNS resolution overhead dropping requests
                    fetch("http://127.0.0.1:10000/claim", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Authorization": `Bearer ${mockUserToken}`
                        },
                        body: JSON.stringify({
                            campaignId: campaignId,
                            userName: `Stress Tester ${reqIdx}`
                        })
                    }).then(async r => {
                        const text = await r.text();
                        return { status: r.status, text };
                    }).catch(err => {
                        return { status: 500, text: `Client Connection Drop: ${err.message}` };
                    })
                );
            }

            // Await the current batch before firing the next 300 requests
            const batchResults = await Promise.all(batch);
            
            batchResults.forEach(res => {
                if (res.status === 200) {
                    successCount++;
                } else {
                    failCount++;
                    reasons[res.text] = (reasons[res.text] || 0) + 1;
                }
            });
        }

        const endTime = Date.now();
        const timeTakenMs = endTime - startTime;

        console.log("====== 📈 PERFORMANCE REPORT ======");
        console.log(`Event Target:           "${targetCampaign.title}"`);
        console.log(`Total Requests Sent:    ${iterations}`);
        console.log(`Time Taken (Latency):   ${timeTakenMs} ms`);
        console.log(`Throughput Speed:       ${(iterations / (timeTakenMs / 1000)).toFixed(2)} req/sec`);
        console.log(`\n✅ Approved Claims:      ${successCount}`);
        console.log(`❌ Failed Claims:        ${failCount}`);
        
        if (Object.keys(reasons).length > 0) {
            console.log(`\nFailure Reasons Breakdown & Diagnosis:`);
            for (const [reason, count] of Object.entries(reasons)) {
                 let explanation = "Unknown Error";
                 if (reason.includes("Sold Out")) {
                     explanation = "Expected behavior. Event ran out of tickets before this request could be finalized.";
                 } else if (reason.includes("scale contention")) {
                     explanation = "Expected behavior. MongoDB transaction was safely aborted to prevent a concurrent race condition double-booking.";
                 } else if (reason.includes("Campaign not started")) {
                     explanation = "Expected behavior. The event hasn't started yet.";
                 } else if (reason.includes("ECONNRESET") || reason.includes("fetch failed") || reason.includes("Client Connection Drop")) {
                     explanation = "Network Overload. The backend or OS socket pool dropped the connection under extreme traffic.";
                 } else {
                     // Clean up potentially long HTML error strings
                     explanation = "Unexpected Backend Exception. Check server logs.";
                 }

                 const cleanReason = reason.length > 80 ? reason.substring(0, 80) + '...' : reason;
                 console.log(`     -> Error: "${cleanReason}"`);
                 console.log(`        Count: ${count} time(s)`);
                 console.log(`        Diagnosis: ${explanation}\n`);
            }
        }
        console.log("===================================\n");

        // Logic check: Asserting Backend Race Condition safety
        const maxExpectedSuccess = Math.min(iterations, seatsAvailable > 0 ? seatsAvailable : 0);
        
        if (successCount === maxExpectedSuccess) {
            console.log("🛡️ BACKEND HEALTHY: Zero race conditions detected. Atomicity holds up perfectly!");
        } else if (successCount > maxExpectedSuccess) {
            console.log("🚨 VULNERABILITY DETECTED: Race condition occurred! Backend allowed more claims than the limit.");
        } else {
            console.log("⚠️ SERVER STRUGGLING: Some requests were dropped entirely, likely due to Event Loop blocking under high concurrent load.");
        }

        process.exit(0);

    } catch (err) {
        console.error("Test completely failed to connect:", err.message);
        process.exit(1);
    }
}

run();
