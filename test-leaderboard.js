import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const API_BASE_URL = 'http://localhost:4000/api';
let token = '';

async function login() {
    try {
        const res = await axios.post(`${API_BASE_URL}/auth/login`, {
            email: 'admin@admin.com',
            password: 'Admin@1234'
        });
        token = res.data.accessToken;
        console.log('✅ Login successful');
    } catch (err) {
        console.error('❌ Login failed. Please ensure the server is running and admin credentials are correct.');
        process.exit(1);
    }
}

async function testLeaderboard() {
    try {
        console.log('Testing GET /api/leaderboard...');
        const res = await axios.get(`${API_BASE_URL}/leaderboard`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log(`✅ Leaderboard fetched. Found ${res.data.length} participants.`);

        if (res.data.length > 0) {
            const first = res.data[0];
            console.log(`Testing breakdown for participant ${first.fullName} (${first.id})...`);
            const breakdownRes = await axios.get(`${API_BASE_URL}/leaderboard/${first.id}/breakdown`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            console.log('✅ Breakdown fetched successfully:');
            console.log(`- Score: ${breakdownRes.data.currentScore}`);
            console.log(`- Metrics: ${Object.keys(breakdownRes.data.metrics).join(', ')}`);
        }
    } catch (err) {
        console.error('❌ Leaderboard tests failed:', err.response?.data || err.message);
    }
}

async function testConfig() {
    try {
        console.log('Testing GET /api/leaderboard/config...');
        const res = await axios.get(`${API_BASE_URL}/leaderboard/config`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('✅ Config fetched successfully');

        console.log('Testing PATCH /api/leaderboard/config...');
        const updateRes = await axios.patch(`${API_BASE_URL}/leaderboard/config`, {
            appointmentWeight: 0.3,
            adherenceWeight: 0.2
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('✅ Config updated successfully');
        console.log(`- New Appointment Weight: ${updateRes.data.appointmentWeight}`);
    } catch (err) {
        console.error('❌ Config tests failed:', err.response?.data || err.message);
    }
}

async function runTests() {
    await login();
    await testLeaderboard();
    await testConfig();
}

runTests();
