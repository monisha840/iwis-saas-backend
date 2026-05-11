import dotenv from 'dotenv';
dotenv.config();
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
    console.log('Starting database seeding...');

    const users = [
        {
            email: 'admin@admin.com',
            password: 'Admin@1234',
            role: 'ADMIN_DOCTOR',
            profile: {
                type: 'doctor',
                data: {
                    fullName: 'Dr. Admin',
                    specialization: 'General Medicine',
                    qualification: 'MBBS, MD',
                    yearsExperience: 10,
                    clinic: 'Al-Shifa Hospital'
                }
            }
        },
        {
            email: 'doctor@iwis.com',
            password: 'Doctor@123',
            role: 'DOCTOR',
            profile: {
                type: 'doctor',
                data: {
                    fullName: 'Dr. John Smith',
                    specialization: 'Cardiology',
                    qualification: 'MBBS, DM (Cardiology)',
                    yearsExperience: 8,
                    clinic: 'Al-Shifa Hospital'
                }
            }
        },
        {
            email: 'therapist@iwis.com',
            password: 'Therapist@123',
            role: 'THERAPIST',
            profile: {
                type: 'therapist',
                data: {
                    fullName: 'Sarah Johnson',
                    specialization: 'Physical Therapy',
                    qualification: 'BPT, MPT',
                    yearsExperience: 6,
                    clinic: 'Al-Shifa Hospital'
                }
            }
        },
        {
            email: 'patient@iwis.com',
            password: 'Patient@123',
            role: 'PATIENT',
            profile: {
                type: 'patient',
                data: {
                    fullName: 'Test Patient',
                    gender: 'Male',
                    age: 35,
                    phoneNumber: '+91-9876543210',
                    therapyTypes: ['Physical']
                }
            }
        }
    ];

    for (const userData of users) {
        try {
            // Check if user already exists
            const existing = await prisma.user.findUnique({
                where: { email: userData.email }
            });

            if (existing) {
                console.log(`✓ User already exists: ${userData.email}`);
                continue;
            }

            // Hash password
            const hashedPassword = await bcrypt.hash(userData.password, 10);

            // Create user with profile
            const createData = {
                email: userData.email,
                password: hashedPassword,
                role: userData.role,
            };

            // Add profile relation
            if (userData.profile.type === 'doctor') {
                createData.doctor = { create: userData.profile.data };
            } else if (userData.profile.type === 'therapist') {
                createData.therapist = { create: userData.profile.data };
            } else if (userData.profile.type === 'patient') {
                createData.patient = { create: userData.profile.data };
            }

            const user = await prisma.user.create({ data: createData });

            console.log(`✓ Created user: ${userData.email} (${userData.role})`);
            console.log(`  Password: ${userData.password}`);

        } catch (error) {
            console.error(`✗ Error creating user ${userData.email}:`, error.message);
        }
    }

    console.log('\n✅ Database seeding completed!');
    console.log('\n📝 Login Credentials:');
    console.log('─'.repeat(60));
    users.forEach(user => {
        console.log(`${user.role.padEnd(15)} | ${user.email.padEnd(20)} | ${user.password}`);
    });
    console.log('─'.repeat(60));
}

main()
    .catch((e) => {
        console.error('❌ Seeding failed:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
