import dotenv from 'dotenv';
dotenv.config();
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';

async function testMe() {
    const secret = process.env.JWT_SECRET;
    const token = jwt.sign({ id: 'df54b39c-c1ce-4b2a-a2ae-67481bbc7d50', role: 'ADMIN_DOCTOR' }, secret, { expiresIn: '1m' });

    console.log('Testing /me with token:', token);

    try {
        const res = await fetch('http://localhost:4000/api/user/me', {
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        console.log('Response Status:', res.status);
        console.log('Response Data:', JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Fetch error:', error);
    }
}

testMe();
