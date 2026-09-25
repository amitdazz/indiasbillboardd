// 1. Replace these with your actual Supabase URL and Anon Key (found in Supabase Dashboard > Settings > API)
const SUPABASE_URL = 'https://tawkqcwzlbyrmjuzcezd.supabase.co/rest/v1/'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRhd2txY3d6bGJ5cm1qdXpjZXpkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNTExMTgsImV4cCI6MjEwNTgyNzExOH0.V5UvAkZwavw4uQPmxZBGUZELbhwYU5NB5MLXssmkZas'

const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// 2. Fetch data automatically when the page loads
document.addEventListener("DOMContentLoaded", fetchAdminData);

async function fetchAdminData() {
    // Fetch data from the 'bids' table ordered by highest bid amount
    const { data: bids, error } = await supabase
        .from('bids')
        .select('*')
        .order('bid_amount', { ascending: false });

    if (error) {
        console.error("Error fetching data:", error);
        return;
    }

    // Update the dashboard UI
    updateDashboardUI(bids);
}

function updateDashboardUI(bids) {
    const tableBody = document.getElementById("bidsTableBody");
    tableBody.innerHTML = ""; // Clear loading message

    let totalBidsCount = 0;
    let pendingCount = 0;

    bids.forEach(bid => {
        totalBidsCount++;
        if (bid.status === 'pending') pendingCount++;

        // Set status text color
        let statusColor = "text-orange-500"; // Pending
        if (bid.status === 'approved') statusColor = "text-green-500";
        if (bid.status === 'outbid') statusColor = "text-red-500";

        // Render table row
        const row = `
            <tr class="border-b hover:bg-gray-50">
                <td class="p-4 font-semibold text-gray-800">${bid.brand_name}</td>
                <td class="p-4 text-gray-600">${bid.billboard_id}</td>
                <td class="p-4 font-bold text-gray-800">₹${bid.bid_amount}</td>
                <td class="p-4 font-semibold ${statusColor}">${bid.status.toUpperCase()}</td>
                <td class="p-4">
                    ${bid.status === 'pending' 
                        ? `<button onclick="approveBid(${bid.id})" class="bg-green-500 text-white px-3 py-1 rounded hover:bg-green-600">Approve Next Brand</button>` 
                        : `<span class="text-gray-400">Done</span>`
                    }
                </td>
            </tr>
        `;
        tableBody.innerHTML += row;
    });

    // Update stats cards at the top
    document.getElementById("totalBids").innerText = totalBidsCount;
    document.getElementById("pendingApprovals").innerText = pendingCount;
}

// 3. Handle Approve Button Click
async function approveBid(bidId) {
    const confirmAction = confirm("Do you want to approve this brand as the next live billboard ad?");
    if (!confirmAction) return;

    // Update the status to 'approved' in Supabase
    const { data, error } = await supabase
        .from('bids')
        .update({ status: 'approved' })
        .eq('id', bidId);

    if (error) {
        alert("Error approving brand: " + error.message);
    } else {
        alert("Brand successfully approved!");
        fetchAdminData(); // Refresh data without reloading the page
    }
}