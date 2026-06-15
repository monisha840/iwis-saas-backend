-- CreateEnum
CREATE TYPE "AssignmentType" AS ENUM ('PRIMARY', 'CONSULTING', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ACTIVE', 'ENDED', 'REPLACED');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "StaffThreadKind" AS ENUM ('DIRECT', 'GROUP');

-- CreateEnum
CREATE TYPE "StaffThreadMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "StaffMessageKind" AS ENUM ('TEXT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT', 'ADMIN', 'PHARMACIST', 'BRANCH_ADMIN');

-- CreateEnum
CREATE TYPE "ConsultationType" AS ENUM ('DOCTOR', 'THERAPIST', 'COMBINED');

-- CreateEnum
CREATE TYPE "RetentionStatus" AS ENUM ('COMPLETED', 'PARTIAL', 'NOT_FOLLOWED');

-- CreateEnum
CREATE TYPE "FeedbackMcqOption" AS ENUM ('A', 'B', 'C', 'D');

-- CreateEnum
CREATE TYPE "FeedbackSentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "ThankYouCardVisibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- CreateEnum
CREATE TYPE "JourneyStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'PAUSED', 'DISCONTINUED');

-- CreateEnum
CREATE TYPE "PhaseStatus" AS ENUM ('UPCOMING', 'ACTIVE', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('MEDICATION', 'EXERCISE', 'DIET', 'THERAPY', 'LIFESTYLE');

-- CreateEnum
CREATE TYPE "VitalType" AS ENUM ('PAIN_SCORE', 'WEIGHT', 'BP_SYSTOLIC', 'BP_DIASTOLIC', 'GLUCOSE', 'SLEEP_HOURS', 'MOOD');

-- CreateEnum
CREATE TYPE "BadgeTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'PLATINUM');

-- CreateEnum
CREATE TYPE "SharingStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "StaffActivityType" AS ENUM ('LOGIN', 'LOGOUT', 'CONSULTATION_START', 'CONSULTATION_END', 'BREAK_START', 'BREAK_END', 'STATUS_CHANGE');

-- CreateEnum
CREATE TYPE "StaffPresenceStatus" AS ENUM ('ONLINE', 'IN_CONSULTATION', 'ON_BREAK', 'IDLE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'HALF_DAY', 'LEAVE', 'WFH');

-- CreateEnum
CREATE TYPE "SkillLevel" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('PENDING', 'APPROVED', 'FULFILLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "QuestStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'EXPIRED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "AnnouncementPriority" AS ENUM ('URGENT', 'HIGH', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('DRAFT', 'SENT', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "HospitalStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING_SETUP', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "HospitalPlan" AS ENUM ('STARTER', 'PROFESSIONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "TherapyRoomType" AS ENUM ('SHIRODHARA', 'ABHYANGA', 'PANCHAKARMA_GENERAL', 'STEAM', 'CONSULTATION', 'GROUP');

-- CreateEnum
CREATE TYPE "DietPackageStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DoshaType" AS ENUM ('VATA', 'PITTA', 'KAPHA', 'TRIDOSHA');

-- CreateEnum
CREATE TYPE "DietCategory" AS ENUM ('SATTVIC', 'RAJASIC', 'TAMASIC');

-- CreateEnum
CREATE TYPE "MealTime" AS ENUM ('MORNING_EMPTY', 'BREAKFAST', 'MID_MORNING', 'LUNCH', 'EVENING', 'DINNER', 'BEDTIME');

-- CreateEnum
CREATE TYPE "PhotoCategory" AS ENUM ('SKIN_CONDITION', 'SWELLING_OEDEMA', 'WOUND_HEALING', 'WEIGHT_CHANGE', 'GENERAL_PROGRESS');

-- CreateEnum
CREATE TYPE "PhotoStage" AS ENUM ('BEFORE', 'DURING', 'AFTER');

-- CreateEnum
CREATE TYPE "AyurvedicSkill" AS ENUM ('ABHYANGA', 'SHIRODHARA', 'PANCHAKARMA_GENERAL', 'BASTI', 'VIRECHANA', 'NASYA', 'KIZHI', 'NJAVARA', 'PIZHICHIL', 'MARMA_THERAPY', 'YOGA_THERAPY', 'NATUROPATHY');

-- CreateEnum
CREATE TYPE "Proficiency" AS ENUM ('CERTIFIED', 'EXPERIENCED', 'LEARNING');

-- CreateEnum
CREATE TYPE "EnrolmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED', 'PAUSED');

-- CreateEnum
CREATE TYPE "GroupSessionStatus" AS ENUM ('OPEN', 'FULL', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TodoPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TodoStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "SelfExamStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'REVIEWED');

-- CreateEnum
CREATE TYPE "PainZone" AS ENUM ('HEAD_MIGRAINE', 'NECK', 'SHOULDER', 'CHEST', 'LOWER_BACK', 'ABDOMEN', 'KNEE', 'WRIST_HAND', 'GENERALISED_MUSCLE');

-- CreateEnum
CREATE TYPE "PainCharacter" AS ENUM ('THROBBING', 'PRESSING', 'STABBING', 'DULL', 'BURNING', 'SHARP', 'ACHING', 'CRAMPING', 'GRINDING', 'HEAVY', 'TIGHT', 'COLICKY', 'BLOATING');

-- CreateEnum
CREATE TYPE "TongueCoatingColor" AS ENUM ('NONE', 'WHITE', 'YELLOW', 'RED');

-- CreateEnum
CREATE TYPE "TongueCoatingThickness" AS ENUM ('NONE', 'THIN', 'THICK');

-- CreateEnum
CREATE TYPE "StoolConsistency" AS ENUM ('HARD_PELLETS', 'FORMED', 'SOFT', 'LOOSE', 'WATERY', 'MUCOUSY');

-- CreateEnum
CREATE TYPE "StoolColour" AS ENUM ('BROWN', 'PALE', 'YELLOW_GREEN', 'DARK');

-- CreateEnum
CREATE TYPE "StoolMealRelation" AS ENUM ('BEFORE_MEALS', 'AFTER_MEALS', 'BOTH', 'NONE');

-- CreateEnum
CREATE TYPE "UrineColour" AS ENUM ('PALE', 'NORMAL_YELLOW', 'DARK_YELLOW', 'BROWN');

-- CreateEnum
CREATE TYPE "RoMJoint" AS ENUM ('NECK', 'SHOULDER_LEFT', 'SHOULDER_RIGHT', 'KNEE_LEFT', 'KNEE_RIGHT');

-- CreateEnum
CREATE TYPE "RoMDirection" AS ENUM ('NECK_ROTATE_LEFT', 'NECK_ROTATE_RIGHT', 'NECK_FLEX', 'NECK_EXTEND', 'NECK_LATERAL_LEFT', 'NECK_LATERAL_RIGHT', 'SHOULDER_FLEX_OVERHEAD', 'SHOULDER_ABDUCT', 'SHOULDER_CROSS_BODY', 'SHOULDER_BEHIND_BACK', 'SHOULDER_EXTERNAL_ROT', 'SHOULDER_INTERNAL_ROT', 'KNEE_FLEX', 'KNEE_EXTEND');

-- CreateEnum
CREATE TYPE "PhysicalObservationType" AS ENUM ('POSTURE_FULL_BODY', 'FACE_EYE', 'HAND_FLAT', 'KNEE_COMPARE', 'SHOULDER_SYMMETRY', 'GENERAL_APPEARANCE');

-- CreateEnum
CREATE TYPE "PrakritiType" AS ENUM ('VATA', 'PITTA', 'KAPHA', 'VATA_PITTA', 'PITTA_KAPHA', 'VATA_KAPHA', 'TRIDOSHA');

-- CreateEnum
CREATE TYPE "AgniType" AS ENUM ('MANDAGNI', 'TIKSHNA', 'VISHAMA', 'SAMA');

-- CreateEnum
CREATE TYPE "AppetiteLevel" AS ENUM ('STRONG', 'MODERATE', 'WEAK', 'IRREGULAR');

-- CreateEnum
CREATE TYPE "SleepPosition" AS ENUM ('BACK', 'LEFT_SIDE', 'RIGHT_SIDE', 'STOMACH', 'MIXED');

-- CreateEnum
CREATE TYPE "MessageTemplateCategory" AS ENUM ('DAILY_CHECKIN', 'APPOINTMENT_CONFIRMATION', 'APPOINTMENT_REMINDER', 'CUSTOM', 'MEDICATION_MISSED_FOLLOWUP', 'MEDICATION_REFILL_3D', 'MEDICATION_REFILL_LAST_DAY');

-- CreateEnum
CREATE TYPE "DeliveryChannel" AS ENUM ('WHATSAPP', 'IN_APP');

-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('DAILY_CHECKIN', 'APPOINTMENT_CONFIRMATION', 'APPOINTMENT_REMINDER', 'MEDICATION_MISSED_FOLLOWUP', 'MEDICATION_REFILL_3D', 'MEDICATION_REFILL_LAST_DAY');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED', 'FALLBACK');

-- CreateEnum
CREATE TYPE "FollowUpInterval" AS ENUM ('SEVEN_DAYS', 'FOURTEEN_DAYS', 'THIRTY_DAYS', 'SIXTY_DAYS', 'NINETY_DAYS', 'CUSTOM', 'SINGLE_VISIT');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'COMPLETED', 'MISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CriticalStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "HomeTherapyStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SessionModeType" AS ENUM ('HOME', 'HOSPITAL');

-- CreateEnum
CREATE TYPE "HomeTherapySessionStatus" AS ENUM ('SCHEDULED', 'THERAPIST_EN_ROUTE', 'THERAPIST_ARRIVED', 'IN_SESSION', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "FoodCategory" AS ENUM ('GRAIN', 'VEGETABLE', 'FRUIT', 'DAIRY', 'SPICE', 'OIL', 'LEGUME', 'MEAT', 'HERB', 'BEVERAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "RasaType" AS ENUM ('SWEET', 'SOUR', 'SALTY', 'PUNGENT', 'BITTER', 'ASTRINGENT');

-- CreateEnum
CREATE TYPE "GunaType" AS ENUM ('HEAVY', 'LIGHT', 'OILY', 'DRY', 'HOT', 'COLD', 'SHARP', 'SOFT', 'STABLE', 'MOBILE');

-- CreateEnum
CREATE TYPE "Season" AS ENUM ('WINTER', 'SUMMER', 'MONSOON', 'AUTUMN', 'SPRING');

-- CreateEnum
CREATE TYPE "VoiceRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "FollowUpTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'DISMISSED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "tokensRevokedAt" TIMESTAMP(3),
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "mfaBackupCodes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "branchId" TEXT,
    "hospitalId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSnapshot" (
    "userId" TEXT NOT NULL,
    "fullName" TEXT,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "branchId" TEXT,
    "branchName" TEXT,
    "hospitalId" TEXT,
    "phoneNumber" TEXT,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSnapshot_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "deviceInfo" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "totalBeds" INTEGER,
    "availableBeds" INTEGER,
    "totalRooms" INTEGER,
    "totalTherapyRooms" INTEGER,
    "ipdEnabled" BOOLEAN NOT NULL DEFAULT false,
    "opdEnabled" BOOLEAN NOT NULL DEFAULT true,
    "operatingHoursFrom" TEXT,
    "operatingHoursTo" TEXT,
    "weeklyClosedDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueEntry" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "queuePosition" INTEGER NOT NULL,
    "arrivalStatus" TEXT NOT NULL DEFAULT 'NOT_ARRIVED',
    "arrivedAt" TIMESTAMP(3),
    "consultationStartedAt" TIMESTAMP(3),
    "consultationEndedAt" TIMESTAMP(3),
    "absentContactedAt" TIMESTAMP(3),
    "contactNote" TEXT,
    "contactedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QueueEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "oldData" JSONB,
    "newData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Doctor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clinic" TEXT,
    "fullName" TEXT,
    "profilePhoto" TEXT,
    "qualification" TEXT,
    "specialization" TEXT,
    "yearsExperience" INTEGER,
    "registrationNumber" TEXT,
    "phoneNumber" TEXT,
    "bio" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Doctor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientAssignment" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "type" "AssignmentType" NOT NULL DEFAULT 'PRIMARY',
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "PatientAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockedSlot" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT,
    "therapistId" TEXT,
    "date" TIMESTAMP(3),
    "dayOfWeek" INTEGER,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "reason" TEXT,
    "kind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlockedSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Therapist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clinic" TEXT,
    "fullName" TEXT,
    "profilePhoto" TEXT,
    "qualification" TEXT,
    "gender" TEXT,
    "yearsExperience" INTEGER,
    "registrationNumber" TEXT,
    "phoneNumber" TEXT,
    "bio" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Therapist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pharmacist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT,
    "profilePhoto" TEXT,
    "qualification" TEXT,
    "yearsExperience" INTEGER,
    "phoneNumber" TEXT,
    "bio" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pharmacist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "age" INTEGER,
    "dob" TIMESTAMP(3),
    "fullName" TEXT,
    "gender" TEXT,
    "profilePhoto" TEXT,
    "patientId" TEXT,
    "phoneNumber" TEXT,
    "therapyType" TEXT,
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "onboardingData" JSONB,
    "zenPoints" INTEGER NOT NULL DEFAULT 0,
    "branchId" TEXT,
    "voiceCoachEnabled" BOOLEAN NOT NULL DEFAULT true,
    "preferredCoachLang" TEXT NOT NULL DEFAULT 'ta',
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pincode" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "primaryPhone" TEXT,
    "alternativePhone" TEXT,
    "locationVerified" BOOLEAN NOT NULL DEFAULT false,
    "allergies" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyCheckIn" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "painLevel" INTEGER NOT NULL,
    "painRegions" JSONB,
    "mobilityScore" INTEGER,
    "sleepHours" DOUBLE PRECISION NOT NULL,
    "mood" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExerciseVideo" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "videoUrl" TEXT NOT NULL,
    "thumbnail" TEXT,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExerciseVideo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoPrescription" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT,
    "therapistId" TEXT,
    "videoId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "branchId" TEXT,

    CONSTRAINT "VideoPrescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT,
    "therapistId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "consultationType" "ConsultationType" NOT NULL DEFAULT 'DOCTOR',
    "consultationMode" TEXT NOT NULL DEFAULT 'OFFLINE',
    "meetingLink" TEXT,
    "therapistDate" TIMESTAMP(3),
    "sessionNotes" TEXT,
    "triageSessionId" TEXT,
    "dailyRoomName" TEXT,
    "dailyRoomUrl" TEXT,
    "dailyRoomExpiry" TIMESTAMP(3),
    "videoSessionStartedAt" TIMESTAMP(3),
    "videoSessionEndedAt" TIMESTAMP(3),
    "branchId" TEXT,
    "doctorApproved" BOOLEAN NOT NULL DEFAULT false,
    "therapistApproved" BOOLEAN NOT NULL DEFAULT false,
    "notificationSent" BOOLEAN NOT NULL DEFAULT false,
    "isWalkIn" BOOLEAN NOT NULL DEFAULT false,
    "walkInNotes" TEXT,
    "csatSentAt" TIMESTAMP(3),
    "therapyRoomId" TEXT,
    "groupSessionId" TEXT,
    "isGroupBooking" BOOLEAN NOT NULL DEFAULT false,
    "customReminderTemplateId" TEXT,
    "customReminderBody" TEXT,
    "customReminderSubject" TEXT,
    "customReminderChannels" "DeliveryChannel"[] DEFAULT ARRAY[]::"DeliveryChannel"[],
    "customReminderUpdatedAt" TIMESTAMP(3),
    "customReminderUpdatedById" TEXT,
    "journeyId" TEXT,
    "arrivalStatus" TEXT NOT NULL DEFAULT 'NOT_ARRIVED',
    "arrivedAt" TIMESTAMP(3),
    "consultationStartedAt" TIMESTAMP(3),
    "consultationEndedAt" TIMESTAMP(3),
    "queuePosition" INTEGER,
    "absentContactedAt" TIMESTAMP(3),

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prescription" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT,
    "therapistId" TEXT,
    "medicineId" TEXT,
    "fileUrl" TEXT,
    "medicationName" TEXT NOT NULL,
    "dosage" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "duration" TEXT NOT NULL,
    "notes" TEXT,
    "totalQuantity" INTEGER NOT NULL DEFAULT 0,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 5,
    "refillNotifiedAt" TIMESTAMP(3),
    "startDate" TIMESTAMP(3),
    "expectedEndDate" TIMESTAMP(3),
    "dailyDoseCount" INTEGER,
    "dispensedQty" INTEGER NOT NULL DEFAULT 0,
    "consumedQty" INTEGER NOT NULL DEFAULT 0,
    "missedDoseNotifiedAt" TIMESTAMP(3),
    "missedDoseStreak" INTEGER NOT NULL DEFAULT 0,
    "threeDayNotifiedAt" TIMESTAMP(3),
    "lastDayNotifiedAt" TIMESTAMP(3),
    "discontinuedAt" TIMESTAMP(3),
    "discontinuedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoUrl" TEXT,
    "sku" TEXT,
    "branchId" TEXT,
    "appointmentId" TEXT,
    "packageId" TEXT,
    "journeyId" TEXT,

    CONSTRAINT "Prescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Availability" (
    "id" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'INFO',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "relatedId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "externalId" TEXT,
    "errorMessage" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsappNumber" TEXT,
    "appointmentReminders" BOOLEAN NOT NULL DEFAULT true,
    "systemAlerts" BOOLEAN NOT NULL DEFAULT true,
    "prescriptionUpdates" BOOLEAN NOT NULL DEFAULT true,
    "medicationReminders" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "triageSessionId" TEXT,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Journey" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "therapistId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "totalSessions" INTEGER NOT NULL,
    "completedSessions" INTEGER NOT NULL DEFAULT 0,
    "progressNotes" TEXT,
    "treatmentGoals" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Journey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationLog" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT,
    "prescriptionId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "medicationName" TEXT NOT NULL,
    "dosage" TEXT NOT NULL,
    "slot" TEXT,
    "scheduledTime" TEXT,
    "quantityTaken" INTEGER NOT NULL DEFAULT 1,
    "taken" BOOLEAN NOT NULL DEFAULT false,
    "takenAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkOperation" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "initiatedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalRecords" INTEGER NOT NULL,
    "processedRecords" INTEGER NOT NULL DEFAULT 0,
    "failedRecords" INTEGER NOT NULL DEFAULT 0,
    "errorLog" JSONB,
    "fileUrl" TEXT,
    "resultFileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BulkOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL,
    "paymentMethod" TEXT,
    "transactionId" TEXT,
    "description" TEXT,
    "appointmentId" TEXT,
    "invoiceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "invoiceId" TEXT,
    "branchId" TEXT,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Medicine" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "category" TEXT,
    "type" TEXT,
    "manufacturer" TEXT,
    "composition" TEXT,
    "description" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoUrl" TEXT,
    "sku" TEXT,
    "hsn" TEXT,
    "pharmacologicalName" TEXT,
    "riskLevel" TEXT,
    "maxSalesDiscount" DOUBLE PRECISION,
    "tax" DOUBLE PRECISION,
    "purchaseUnit" TEXT,
    "qtyPerPurchaseUnit" INTEGER,

    CONSTRAINT "Medicine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicineStock" (
    "id" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "batchNumber" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "minStock" INTEGER NOT NULL DEFAULT 10,
    "location" TEXT,
    "purchasePrice" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "branchId" TEXT,

    CONSTRAINT "MedicineStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PharmacyDispense" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "prescriptionId" TEXT,
    "dispensedBy" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "orderId" TEXT,
    "branchId" TEXT,

    CONSTRAINT "PharmacyDispense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PharmacyOrder" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "prescriptionId" TEXT,
    "orderedBy" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "urgency" TEXT NOT NULL DEFAULT 'NORMAL',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "branchId" TEXT,

    CONSTRAINT "PharmacyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PharmacyOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "totalPrice" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PharmacyOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispenseItem" (
    "id" TEXT NOT NULL,
    "dispenseId" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "totalPrice" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "DispenseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "taxAmount" DOUBLE PRECISION DEFAULT 0,
    "discount" DOUBLE PRECISION DEFAULT 0,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'UNPAID',
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "branchId" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "totalPrice" DOUBLE PRECISION NOT NULL,
    "medicineId" TEXT,

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriageSession" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "responses" JSONB NOT NULL,
    "severity" TEXT NOT NULL,
    "suggestedSpecialty" TEXT,
    "isEscalated" BOOLEAN NOT NULL DEFAULT false,
    "compositeScore" DOUBLE PRECISION,
    "urgencyLevel" TEXT,
    "confidenceScore" DOUBLE PRECISION,
    "alternativeSpecialties" TEXT[],
    "flags" TEXT[],
    "triageNotes" TEXT,
    "painRegions" JSONB,
    "lifestyleData" JSONB,
    "inputCompleteness" DOUBLE PRECISION,
    "routingMatchStrength" DOUBLE PRECISION,
    "redFlagsMatched" TEXT[],
    "redFlagForced" BOOLEAN NOT NULL DEFAULT false,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "previousScore" DOUBLE PRECISION,
    "previousUrgencyLevel" TEXT,
    "escalatedAfterUpdate" BOOLEAN NOT NULL DEFAULT false,
    "deEscalatedAfterUpdate" BOOLEAN NOT NULL DEFAULT false,
    "heldSlotClinicianId" TEXT,
    "heldSlotDate" TIMESTAMP(3),
    "heldSlotTime" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "overriddenUrgencyLevel" TEXT,
    "overriddenSpecialty" TEXT,
    "overrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "branchId" TEXT,

    CONSTRAINT "TriageSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriageOverride" (
    "id" TEXT NOT NULL,
    "triageSessionId" TEXT NOT NULL,
    "reviewerUserId" TEXT,
    "originalUrgencyLevel" TEXT,
    "overriddenUrgencyLevel" TEXT,
    "originalSpecialty" TEXT,
    "overriddenSpecialty" TEXT,
    "reason" TEXT,
    "factorDisagreement" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriageOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpecialtyRoute" (
    "id" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "tags" TEXT[],
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialtyRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT,
    "therapistId" TEXT,
    "pharmacistId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "branchId" TEXT,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffThread" (
    "id" TEXT NOT NULL,
    "kind" "StaffThreadKind" NOT NULL,
    "title" TEXT,
    "hospitalId" TEXT NOT NULL,
    "branchId" TEXT,
    "directKey" TEXT,
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffThreadMember" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "StaffThreadMemberRole" NOT NULL DEFAULT 'MEMBER',
    "isAutoIncluded" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "addedById" TEXT,

    CONSTRAINT "StaffThreadMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderId" TEXT,
    "kind" "StaffMessageKind" NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardConfig" (
    "id" TEXT NOT NULL,
    "appointmentWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "adherenceWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "responseTimeWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "successRateWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "consistencyWeight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "targetAppointments" INTEGER NOT NULL DEFAULT 50,
    "targetAdherence" DOUBLE PRECISION NOT NULL DEFAULT 90.0,
    "targetSuccessRate" DOUBLE PRECISION NOT NULL DEFAULT 80.0,
    "targetResponseTime" DOUBLE PRECISION NOT NULL DEFAULT 30.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderboardConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "allowedRoles" TEXT[],
    "allowedBranches" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefillRequest" (
    "id" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefillRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "referredId" TEXT,
    "referralCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "rewardGranted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardAudit" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participantRole" "Role" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "metrics" JSONB NOT NULL,
    "weights" JSONB NOT NULL,
    "sourceRecordIds" JSONB,
    "integrityHash" TEXT,
    "rank" INTEGER,
    "calculationDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaderboardAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionChecklist" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "clinicianRole" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "branchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetentionChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentFeedback" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "branchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsultationFeedback" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT,
    "clinicianId" TEXT,
    "clinicianRole" "Role",
    "branchId" TEXT,
    "faceScaleEmotional" INTEGER,
    "faceScaleConfidence" INTEGER,
    "mcqListening" "FeedbackMcqOption",
    "mcqReturn" "FeedbackMcqOption",
    "rating" INTEGER,
    "sentiment" "FeedbackSentiment",
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "feedbackText" TEXT,
    "xpAwarded" INTEGER NOT NULL DEFAULT 0,
    "xpRewardClaimed" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ConsultationFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyFeedback" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "leadDoctorId" TEXT NOT NULL,
    "primaryClinicianId" TEXT,
    "branchId" TEXT,
    "mcqAppointments" "FeedbackMcqOption",
    "mcqReminders" "FeedbackMcqOption",
    "mcqMedications" "FeedbackMcqOption",
    "mcqFamilyRecommendation" "FeedbackMcqOption",
    "gardenScore" INTEGER,
    "faceScaleExperience" INTEGER,
    "thankYouCardText" TEXT,
    "thankYouCardPublic" BOOLEAN NOT NULL DEFAULT false,
    "photosViewed" BOOLEAN NOT NULL DEFAULT false,
    "xpAwarded" INTEGER NOT NULL DEFAULT 0,
    "xpDistribution" JSONB NOT NULL DEFAULT '{}',
    "overallRating" INTEGER,
    "outcomeRating" INTEGER,
    "adherenceRating" INTEGER,
    "sentiment" "FeedbackSentiment",
    "highlights" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "feedbackText" TEXT,
    "wouldRecommend" BOOLEAN,
    "xpRewardClaimed" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "JourneyFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThankYouCard" (
    "id" TEXT NOT NULL,
    "feedbackId" TEXT NOT NULL,
    "recipientDoctorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "visibility" "ThankYouCardVisibility" NOT NULL DEFAULT 'PRIVATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThankYouCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreatmentJourney" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetDate" TIMESTAMP(3),
    "status" "JourneyStatus" NOT NULL DEFAULT 'ACTIVE',
    "wellnessScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreatmentJourney_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyPhase" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "durationDays" INTEGER NOT NULL DEFAULT 7,
    "status" "PhaseStatus" NOT NULL DEFAULT 'UPCOMING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "JourneyPhase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhaseTask" (
    "id" TEXT NOT NULL,
    "phaseId" TEXT NOT NULL,
    "type" "TaskType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "frequency" TEXT NOT NULL,

    CONSTRAINT "PhaseTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskCompletion" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "mediaUrl" TEXT,

    CONSTRAINT "TaskCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JourneyMilestone" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "targetDate" TIMESTAMP(3),
    "achievedAt" TIMESTAMP(3),
    "isAchieved" BOOLEAN NOT NULL DEFAULT false,
    "badgeIcon" TEXT,

    CONSTRAINT "JourneyMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientVital" (
    "id" TEXT NOT NULL,
    "journeyId" TEXT,
    "patientId" TEXT NOT NULL,
    "type" "VitalType" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'manual',

    CONSTRAINT "PatientVital_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrescribedVital" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "vitalType" "VitalType" NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'DAILY',
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "prescribedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrescribedVital_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Badge" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "tier" "BadgeTier" NOT NULL,
    "criteria" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBadge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicianStreak" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participantRole" "Role" NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveDate" TIMESTAMP(3),
    "graceUsedThisWeek" BOOLEAN NOT NULL DEFAULT false,
    "streakMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicianStreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchCompetition" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "metric" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchCompetition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BranchCompetitionEntry" (
    "id" TEXT NOT NULL,
    "competitionId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BranchCompetitionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyChallenge" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "pointReward" INTEGER NOT NULL DEFAULT 10,
    "activeDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientChallengeCompletion" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientChallengeCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZenPointsLedger" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZenPointsLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientStreak" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveDate" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientStreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoshaForecast" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "daysUntilSymp" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "dominantDosha" TEXT NOT NULL,
    "imbalanceType" TEXT NOT NULL,
    "triggerFactors" TEXT[],
    "alertEmitted" BOOLEAN NOT NULL DEFAULT false,
    "alertEmittedAt" TIMESTAMP(3),
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DoshaForecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NudgeLog" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archetype" TEXT NOT NULL,
    "messageText" TEXT NOT NULL,
    "checkInCompleted" BOOLEAN NOT NULL DEFAULT false,
    "checkInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NudgeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GamificationAnomaly" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participantRole" "Role" NOT NULL,
    "anomalyType" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GamificationAnomaly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdaptiveTarget" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "participantRole" "Role" NOT NULL,
    "metric" TEXT NOT NULL,
    "personalTarget" DOUBLE PRECISION NOT NULL,
    "baseTarget" DOUBLE PRECISION NOT NULL,
    "adjustmentReason" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdaptiveTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceSharing" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromBranchId" TEXT NOT NULL,
    "toBranchId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "status" "SharingStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "approvedBy" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceSharing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "medicineId" TEXT NOT NULL,
    "fromBranchId" TEXT NOT NULL,
    "toBranchId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffActivity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activityType" "StaffActivityType" NOT NULL,
    "status" "StaffPresenceStatus" NOT NULL DEFAULT 'OFFLINE',
    "metadata" JSONB,
    "branchId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "StaffActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceScorecard" (
    "id" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "clinicianRole" "Role" NOT NULL,
    "period" TEXT NOT NULL,
    "periodType" TEXT NOT NULL DEFAULT 'MONTHLY',
    "patientsSeenCount" INTEGER NOT NULL DEFAULT 0,
    "avgConsultationMins" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgPatientRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "noShowRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "treatmentCompletionRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "prescriptionAccuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "onTimeRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "overallScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "rawMetrics" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceScorecard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAttendance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "branchId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "scheduledStart" TEXT,
    "scheduledEnd" TEXT,
    "clockIn" TIMESTAMP(3),
    "clockOut" TIMESTAMP(3),
    "status" "AttendanceStatus" NOT NULL DEFAULT 'ABSENT',
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffSkill" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillType" TEXT NOT NULL,
    "skillName" TEXT NOT NULL,
    "proficiency" "SkillLevel" NOT NULL DEFAULT 'INTERMEDIATE',
    "certifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicianXP" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "totalXP" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL DEFAULT 'Intern',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicianXP_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XPLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "xpAmount" INTEGER NOT NULL,
    "sourceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XPLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonalChallenge" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'Trophy',
    "metric" TEXT NOT NULL,
    "target" DOUBLE PRECISION NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
    "targetRoles" TEXT[],
    "rewardXP" INTEGER NOT NULL DEFAULT 100,
    "rewardPoints" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeasonalChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonalChallengeProgress" (
    "id" TEXT NOT NULL,
    "challengeId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "currentValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeasonalChallengeProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'Gift',
    "category" TEXT NOT NULL,
    "pointsCost" INTEGER NOT NULL,
    "stock" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardRedemption" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rewardId" TEXT NOT NULL,
    "pointsSpent" INTEGER NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'PENDING',
    "processedBy" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorSession" (
    "id" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "menteeId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "notes" TEXT,
    "durationMins" INTEGER NOT NULL DEFAULT 30,
    "date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "xpAwarded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MentorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthQuest" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT 'Heart',
    "tasks" JSONB NOT NULL,
    "pointReward" INTEGER NOT NULL DEFAULT 50,
    "durationDays" INTEGER NOT NULL DEFAULT 7,
    "difficulty" TEXT NOT NULL DEFAULT 'EASY',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthQuest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientQuestProgress" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "questId" TEXT NOT NULL,
    "tasksCompleted" JSONB NOT NULL DEFAULT '[]',
    "status" "QuestStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "pointsAwarded" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PatientQuestProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthAvatar" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "avatarType" TEXT NOT NULL DEFAULT 'PLANT',
    "name" TEXT NOT NULL DEFAULT 'Sprout',
    "level" INTEGER NOT NULL DEFAULT 1,
    "health" INTEGER NOT NULL DEFAULT 50,
    "happiness" INTEGER NOT NULL DEFAULT 50,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "lastFedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appearance" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthAvatar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientFamily" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "inviteCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientFamilyMember" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientFamilyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthContent" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "contentUrl" TEXT NOT NULL,
    "thumbnail" TEXT,
    "category" TEXT,
    "requiredLevel" INTEGER NOT NULL DEFAULT 1,
    "requiredPoints" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentUnlock" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentUnlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "priority" "AnnouncementPriority" NOT NULL DEFAULT 'NORMAL',
    "targetRoles" TEXT[],
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementRead" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementRead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HandoffNote" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "fromClinicianId" TEXT NOT NULL,
    "toClinicianId" TEXT,
    "toBranchId" TEXT,
    "summary" TEXT NOT NULL,
    "currentMedications" JSONB,
    "activeConditions" TEXT[],
    "nextSteps" TEXT,
    "urgency" TEXT NOT NULL DEFAULT 'NORMAL',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "HandoffStatus" NOT NULL DEFAULT 'SENT',
    "isAutoGenerated" BOOLEAN NOT NULL DEFAULT false,
    "sourceAppointmentId" TEXT,
    "sentAt" TIMESTAMP(3),
    "handoffDate" TIMESTAMP(3),

    CONSTRAINT "HandoffNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TherapistSessionNote" (
    "id" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "subjective" TEXT,
    "objective" TEXT,
    "assessment" TEXT,
    "plan" TEXT,
    "sessionType" TEXT,
    "duration" INTEGER,
    "nextSessionPlan" TEXT,
    "isVisibleToDoctor" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TherapistSessionNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TherapyOutcome" (
    "id" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "sessionDate" DATE NOT NULL,
    "mobilityScore" INTEGER,
    "painScore" INTEGER,
    "swellingReduced" BOOLEAN,
    "functionalImprovement" TEXT,
    "therapistObservation" TEXT,
    "nextSessionGoal" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TherapyOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisitSummary" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "clinicianId" TEXT NOT NULL,
    "clinicianName" TEXT NOT NULL,
    "diagnosis" TEXT,
    "treatmentNotes" TEXT,
    "prescriptions" JSONB,
    "exercisePlan" JSONB,
    "dietaryAdvice" TEXT,
    "nextSteps" TEXT,
    "followUpDate" TIMESTAMP(3),
    "sentToPatient" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisitSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hospital" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "address" TEXT,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "status" "HospitalStatus" NOT NULL DEFAULT 'ACTIVE',
    "plan" "HospitalPlan" NOT NULL DEFAULT 'STARTER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "suspendedAt" TIMESTAMP(3),
    "suspendedById" TEXT,

    CONSTRAINT "Hospital_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureRegistry" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "phase" TEXT NOT NULL,
    "minPlan" "HospitalPlan" NOT NULL,
    "isCore" BOOLEAN NOT NULL DEFAULT false,
    "defaultEnabled" BOOLEAN NOT NULL DEFAULT false,
    "addedInVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospitalFeatureFlag" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "enabledById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalFeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuperAdminAuditLog" (
    "id" TEXT NOT NULL,
    "superAdminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "hospitalId" TEXT,
    "featureKey" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuperAdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TherapyRoom" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TherapyRoomType" NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TherapyRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TherapyRoomBooking" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TherapyRoomBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DietPrescription" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "journeyId" TEXT,
    "title" TEXT NOT NULL,
    "doshaTarget" "DoshaType" NOT NULL,
    "category" "DietCategory" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "packageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DietPrescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DietPackage" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "doshaTarget" "DoshaType" NOT NULL,
    "category" "DietCategory" NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "status" "DietPackageStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "xpAwarded" INTEGER,
    "approvalNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DietPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DietPackageMeal" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "mealTime" "MealTime" NOT NULL,
    "foods" JSONB NOT NULL,
    "avoidFoods" JSONB NOT NULL,
    "instructions" TEXT,

    CONSTRAINT "DietPackageMeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DietMeal" (
    "id" TEXT NOT NULL,
    "dietPrescriptionId" TEXT NOT NULL,
    "mealTime" "MealTime" NOT NULL,
    "foods" JSONB NOT NULL,
    "avoidFoods" JSONB NOT NULL,
    "instructions" TEXT,

    CONSTRAINT "DietMeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DietAdherenceLog" (
    "id" TEXT NOT NULL,
    "dietPrescriptionId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "mealTime" "MealTime" NOT NULL,
    "followed" BOOLEAN NOT NULL,
    "notes" TEXT,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DietAdherenceLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalPhoto" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "journeyId" TEXT,
    "phaseId" TEXT,
    "category" "PhotoCategory" NOT NULL,
    "stage" "PhotoStage" NOT NULL,
    "bodyRegion" TEXT,
    "notes" TEXT,
    "filePath" TEXT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicalPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TherapistSkill" (
    "id" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "skill" "AyurvedicSkill" NOT NULL,
    "proficiency" "Proficiency" NOT NULL,
    "certifiedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TherapistSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreatmentPackage" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "durationDays" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "taxPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "components" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TreatmentPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageEnrolment" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "EnrolmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "sessionsTotal" INTEGER NOT NULL,
    "sessionsUsed" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PackageEnrolment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageSessionLog" (
    "id" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "sessionType" TEXT NOT NULL,
    "conductedAt" TIMESTAMP(3) NOT NULL,
    "conductedById" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackageSessionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupSession" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "roomId" TEXT,
    "title" TEXT NOT NULL,
    "sessionType" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "maxCapacity" INTEGER NOT NULL,
    "status" "GroupSessionStatus" NOT NULL DEFAULT 'OPEN',
    "attendedParticipantIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "GroupSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Todo" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "priority" "TodoPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "TodoStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" TIMESTAMP(3),
    "xpReward" INTEGER NOT NULL DEFAULT 25,
    "completedAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "assignedToId" TEXT NOT NULL,
    "relatedPatientId" TEXT,
    "relatedAppointmentId" TEXT,
    "branchId" TEXT NOT NULL,
    "reminderSentAt" TIMESTAMP(3),

    CONSTRAINT "Todo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfExamSubmission" (
    "id" TEXT NOT NULL,
    "triageSessionId" TEXT,
    "patientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "branchId" TEXT,
    "hospitalId" TEXT,
    "painZones" "PainZone"[],
    "status" "SelfExamStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "reviewNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfExamSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SymptomHistoryEntry" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "painZone" "PainZone" NOT NULL,
    "subLocation" TEXT,
    "characters" "PainCharacter"[],
    "triggers" TEXT[],
    "relievingFactors" TEXT[],
    "timing" TEXT[],
    "severity" INTEGER NOT NULL,
    "radiatesTo" TEXT,
    "associatedSymptoms" TEXT[],
    "warningSignsBeforeEpisode" TEXT[],
    "injuryHistory" TEXT,
    "occupationContext" TEXT,
    "freeText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SymptomHistoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TongueObservation" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT,
    "checkInId" TEXT,
    "patientId" TEXT NOT NULL,
    "dayIndex" INTEGER,
    "observedOn" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "photoUrl" TEXT,
    "coatingColor" "TongueCoatingColor",
    "coatingThickness" "TongueCoatingThickness",
    "dryness" BOOLEAN NOT NULL DEFAULT false,
    "cracks" BOOLEAN NOT NULL DEFAULT false,
    "tremor" BOOLEAN NOT NULL DEFAULT false,
    "correlatedPainLevel" INTEGER,
    "notes" TEXT,
    "aiCoatingColour" TEXT,
    "aiCoatingThickness" TEXT,
    "aiMoisture" TEXT,
    "doshaIndication" TEXT,
    "confidence" DOUBLE PRECISION,
    "analysisNotes" TEXT,
    "rawAnalysis" TEXT,
    "alertEmitted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TongueObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoolLog" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "dayIndex" INTEGER NOT NULL,
    "observedOn" TIMESTAMP(3) NOT NULL,
    "consistency" "StoolConsistency" NOT NULL,
    "colour" "StoolColour" NOT NULL,
    "frequencyPerDay" INTEGER NOT NULL,
    "daysSinceLastMovement" INTEGER,
    "strainingEffort" INTEGER NOT NULL,
    "incompleteEvacuation" BOOLEAN NOT NULL DEFAULT false,
    "bloatingGas" BOOLEAN NOT NULL DEFAULT false,
    "bloodPresent" BOOLEAN NOT NULL DEFAULT false,
    "mucusPresent" BOOLEAN NOT NULL DEFAULT false,
    "undigestedFood" BOOLEAN NOT NULL DEFAULT false,
    "relationshipToMeal" "StoolMealRelation" NOT NULL DEFAULT 'NONE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoolLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UrineLog" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "dayIndex" INTEGER NOT NULL,
    "observedOn" TIMESTAMP(3) NOT NULL,
    "colour" "UrineColour" NOT NULL,
    "frequencyPerDay" INTEGER NOT NULL,
    "burning" BOOLEAN NOT NULL DEFAULT false,
    "urgency" BOOLEAN NOT NULL DEFAULT false,
    "painCorrelation" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UrineLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoMMeasurement" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "joint" "RoMJoint" NOT NULL,
    "direction" "RoMDirection" NOT NULL,
    "angleDegrees" DOUBLE PRECISION,
    "restriction" TEXT,
    "painScore" INTEGER NOT NULL,
    "crepitus" BOOLEAN NOT NULL DEFAULT false,
    "catchOrSharp" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoMMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhysicalObservation" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "observationType" "PhysicalObservationType" NOT NULL,
    "painZone" "PainZone",
    "photoFrontUrl" TEXT,
    "photoSideUrl" TEXT,
    "photoBackUrl" TEXT,
    "photoExtraUrl" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhysicalObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceObservation" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "dayIndex" INTEGER NOT NULL DEFAULT 1,
    "morningRecUrl" TEXT,
    "eveningRecUrl" TEXT,
    "fatigueNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestiveProfile" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "agniType" "AgniType",
    "appetiteLevel" "AppetiteLevel",
    "bloatingAfterMeals" BOOLEAN NOT NULL DEFAULT false,
    "bloatingDurationMins" INTEGER,
    "heartburnPerWeek" INTEGER,
    "waterIntakeGlasses" INTEGER,
    "coldFoodAggravates" BOOLEAN NOT NULL DEFAULT false,
    "foodTriggers" TEXT[],
    "incompatibleCombinations" TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigestiveProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LifestyleContext" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "pillowType" TEXT,
    "pillowFirmness" TEXT,
    "sleepPosition" "SleepPosition",
    "sleepHours" DOUBLE PRECISION,
    "screenHoursPerDay" INTEGER,
    "occupation" TEXT,
    "pastInjuries" TEXT,
    "regularExercise" TEXT,
    "stressEventsPast6mo" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LifestyleContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConstitutionProfile" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "prakriti" "PrakritiType",
    "satvaRating" INTEGER,
    "agniType" "AgniType",
    "quizAnswers" JSONB,
    "lastUpdatedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConstitutionProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfExamProtocolOverride" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "painZone" "PainZone" NOT NULL,
    "config" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SelfExamProtocolOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "MessageTemplateCategory" NOT NULL,
    "body" TEXT NOT NULL,
    "subject" TEXT,
    "channels" "DeliveryChannel"[] DEFAULT ARRAY['WHATSAPP']::"DeliveryChannel"[],
    "placeholders" JSONB NOT NULL DEFAULT '[]',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderSetting" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "dailyReminderEnabled" BOOLEAN NOT NULL DEFAULT true,
    "dailyReminderTime" TEXT NOT NULL DEFAULT '07:30',
    "dailyReminderChannels" "DeliveryChannel"[] DEFAULT ARRAY['WHATSAPP', 'IN_APP']::"DeliveryChannel"[],
    "dailyReminderTemplateId" TEXT,
    "dailyReminderInlineBody" TEXT,
    "skipIfAlreadyCheckedIn" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastRunTargetCount" INTEGER,
    "lastRunSuccessCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderDeliveryLog" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT,
    "patientUserId" TEXT,
    "appointmentId" TEXT,
    "kind" "ReminderKind" NOT NULL,
    "channel" "DeliveryChannel" NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "target" TEXT,
    "externalId" TEXT,
    "errorMessage" TEXT,
    "body" TEXT,
    "templateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReminderDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentFollowUp" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "interval" "FollowUpInterval" NOT NULL,
    "daysOffset" INTEGER,
    "dueDate" TIMESTAMP(3),
    "isSingleVisit" BOOLEAN NOT NULL DEFAULT false,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "completedByAppointmentId" TEXT,
    "missedNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppointmentFollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientCriticalFlag" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "branchId" TEXT,
    "status" "CriticalStatus" NOT NULL DEFAULT 'ACTIVE',
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientCriticalFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeTherapyRequest" (
    "id" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requestingDoctorId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "totalSessions" INTEGER NOT NULL,
    "sessionMode" "SessionModeType"[] DEFAULT ARRAY[]::"SessionModeType"[],
    "intervalDays" INTEGER,
    "notes" TEXT,
    "status" "HomeTherapyStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approvedById" TEXT,
    "approvedByRole" "Role",
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeTherapyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeTherapySession" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sessionNumber" INTEGER NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "scheduledTime" TEXT NOT NULL,
    "mode" "SessionModeType" NOT NULL,
    "status" "HomeTherapySessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "therapistDepartedAt" TIMESTAMP(3),
    "therapistArrivedAt" TIMESTAMP(3),
    "sessionStartedAt" TIMESTAMP(3),
    "sessionCompletedAt" TIMESTAMP(3),
    "therapistFeedbackId" TEXT,
    "patientFeedbackId" TEXT,
    "appointmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeTherapySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TherapistLocationPing" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "therapistId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TherapistLocationPing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeTherapyFeedback" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "authorRole" "Role" NOT NULL,
    "rating" INTEGER NOT NULL,
    "sentiment" "FeedbackSentiment" NOT NULL,
    "notes" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "xpAwarded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HomeTherapyFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceConversation" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "escalationNote" TEXT,
    "sessionSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "VoiceRole" NOT NULL,
    "transcript" TEXT NOT NULL,
    "audioStorageKey" TEXT,
    "detectedIntent" TEXT,
    "severityFlag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AyurvedicFood" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameInTamil" TEXT,
    "nameInSanskrit" TEXT,
    "category" "FoodCategory" NOT NULL,
    "doshaEffectVata" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "doshaEffectPitta" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "doshaEffectKapha" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "rasa" "RasaType"[],
    "guna" "GunaType"[],
    "virya" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "seasons" "Season"[],
    "preparationMethods" TEXT[],
    "calories" DOUBLE PRECISION,
    "protein" DOUBLE PRECISION,
    "carbs" DOUBLE PRECISION,
    "fat" DOUBLE PRECISION,
    "fiber" DOUBLE PRECISION,
    "commonAllergies" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "branchId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AyurvedicFood_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AyurvedicRecipe" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameInTamil" TEXT,
    "description" TEXT,
    "doshaTargets" TEXT[],
    "prepTimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "cookTimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "servings" INTEGER NOT NULL DEFAULT 2,
    "instructions" TEXT[],
    "mealCategory" TEXT NOT NULL DEFAULT 'GENERAL',
    "imageUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "branchId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AyurvedicRecipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeIngredient" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "foodId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RecipeIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DietMealFoodLink" (
    "id" TEXT NOT NULL,
    "mealId" TEXT NOT NULL,
    "foodId" TEXT,
    "foodNameFree" TEXT,
    "quantity" DOUBLE PRECISION,
    "unit" TEXT,
    "notes" TEXT,
    "isAvoid" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DietMealFoodLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthReport" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "branchId" TEXT NOT NULL,
    "reportType" TEXT NOT NULL DEFAULT 'CONSULTATION',
    "journeyPhaseId" TEXT,
    "reportData" JSONB NOT NULL,
    "pdfPath" TEXT,
    "pdfSizeBytes" INTEGER,
    "sentViaWhatsApp" BOOLEAN NOT NULL DEFAULT false,
    "whatsappSentAt" TIMESTAMP(3),
    "viewedByPatient" BOOLEAN NOT NULL DEFAULT false,
    "viewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpTask" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "FollowUpTaskStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerRef" TEXT,
    "completedAt" TIMESTAMP(3),
    "completionNote" TEXT,
    "xpAwarded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUpTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRule" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggerType" TEXT NOT NULL,
    "conditionValue" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "cooldownHours" INTEGER NOT NULL DEFAULT 48,
    "totalFired" INTEGER NOT NULL DEFAULT 0,
    "lastEvaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRuleLog" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actionsTaken" JSONB NOT NULL,

    CONSTRAINT "WorkflowRuleLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowCooldown" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "lastFiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowCooldown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaterIntakeLog" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "loggedAt" TIMESTAMP(3) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaterIntakeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "activityType" TEXT NOT NULL,
    "durationMins" INTEGER NOT NULL,
    "notes" TEXT,
    "loggedAt" TIMESTAMP(3) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "zenPointsAwarded" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BodyMeasurementLog" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "arm" DOUBLE PRECISION,
    "chest" DOUBLE PRECISION,
    "waist" DOUBLE PRECISION,
    "hip" DOUBLE PRECISION,
    "thigh" DOUBLE PRECISION,
    "weight" DOUBLE PRECISION,
    "notes" TEXT,
    "loggedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BodyMeasurementLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealPhotoLog" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "mealType" TEXT NOT NULL,
    "photoPath" TEXT NOT NULL,
    "photoUrl" TEXT,
    "notes" TEXT,
    "loggedAt" TIMESTAMP(3) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MealPhotoLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyMotivationCard" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "tip" TEXT NOT NULL,
    "prakriti" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "isSaved" BOOLEAN NOT NULL DEFAULT false,
    "savedAt" TIMESTAMP(3),
    "whatsappSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyMotivationCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_AnnouncementTargetBranches" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_branchId_idx" ON "User"("branchId");

-- CreateIndex
CREATE INDEX "User_hospitalId_idx" ON "User"("hospitalId");

-- CreateIndex
CREATE INDEX "UserSnapshot_role_idx" ON "UserSnapshot"("role");

-- CreateIndex
CREATE INDEX "UserSnapshot_branchId_idx" ON "UserSnapshot"("branchId");

-- CreateIndex
CREATE INDEX "UserSnapshot_hospitalId_idx" ON "UserSnapshot"("hospitalId");

-- CreateIndex
CREATE INDEX "UserSnapshot_status_idx" ON "UserSnapshot"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "QueueEntry_appointmentId_key" ON "QueueEntry"("appointmentId");

-- CreateIndex
CREATE INDEX "QueueEntry_doctorId_date_branchId_idx" ON "QueueEntry"("doctorId", "date", "branchId");

-- CreateIndex
CREATE INDEX "QueueEntry_branchId_date_idx" ON "QueueEntry"("branchId", "date");

-- CreateIndex
CREATE INDEX "QueueEntry_date_arrivalStatus_idx" ON "QueueEntry"("date", "arrivalStatus");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_idx" ON "AuditLog"("entityType");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Doctor_userId_key" ON "Doctor"("userId");

-- CreateIndex
CREATE INDEX "PatientAssignment_patientId_status_idx" ON "PatientAssignment"("patientId", "status");

-- CreateIndex
CREATE INDEX "PatientAssignment_doctorId_status_idx" ON "PatientAssignment"("doctorId", "status");

-- CreateIndex
CREATE INDEX "PatientAssignment_assignedById_idx" ON "PatientAssignment"("assignedById");

-- CreateIndex
CREATE INDEX "BlockedSlot_doctorId_idx" ON "BlockedSlot"("doctorId");

-- CreateIndex
CREATE INDEX "BlockedSlot_therapistId_idx" ON "BlockedSlot"("therapistId");

-- CreateIndex
CREATE INDEX "BlockedSlot_date_idx" ON "BlockedSlot"("date");

-- CreateIndex
CREATE INDEX "BlockedSlot_kind_idx" ON "BlockedSlot"("kind");

-- CreateIndex
CREATE INDEX "BlockedSlot_doctorId_date_dayOfWeek_idx" ON "BlockedSlot"("doctorId", "date", "dayOfWeek");

-- CreateIndex
CREATE INDEX "BlockedSlot_therapistId_date_dayOfWeek_idx" ON "BlockedSlot"("therapistId", "date", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "Therapist_userId_key" ON "Therapist"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Pharmacist_userId_key" ON "Pharmacist"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_userId_key" ON "Patient"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_patientId_key" ON "Patient"("patientId");

-- CreateIndex
CREATE INDEX "Patient_branchId_idx" ON "Patient"("branchId");

-- CreateIndex
CREATE INDEX "DailyCheckIn_patientId_createdAt_idx" ON "DailyCheckIn"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "VideoPrescription_patientId_idx" ON "VideoPrescription"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_triageSessionId_key" ON "Appointment"("triageSessionId");

-- CreateIndex
CREATE INDEX "Appointment_patientId_idx" ON "Appointment"("patientId");

-- CreateIndex
CREATE INDEX "Appointment_doctorId_idx" ON "Appointment"("doctorId");

-- CreateIndex
CREATE INDEX "Appointment_therapistId_idx" ON "Appointment"("therapistId");

-- CreateIndex
CREATE INDEX "Appointment_status_idx" ON "Appointment"("status");

-- CreateIndex
CREATE INDEX "Appointment_date_idx" ON "Appointment"("date");

-- CreateIndex
CREATE INDEX "Appointment_branchId_idx" ON "Appointment"("branchId");

-- CreateIndex
CREATE INDEX "Appointment_journeyId_idx" ON "Appointment"("journeyId");

-- CreateIndex
CREATE INDEX "Appointment_doctorId_date_idx" ON "Appointment"("doctorId", "date");

-- CreateIndex
CREATE INDEX "Appointment_therapistId_date_idx" ON "Appointment"("therapistId", "date");

-- CreateIndex
CREATE INDEX "Appointment_patientId_status_idx" ON "Appointment"("patientId", "status");

-- CreateIndex
CREATE INDEX "Appointment_status_date_idx" ON "Appointment"("status", "date");

-- CreateIndex
CREATE INDEX "Appointment_branchId_date_idx" ON "Appointment"("branchId", "date");

-- CreateIndex
CREATE INDEX "Appointment_notificationSent_status_idx" ON "Appointment"("notificationSent", "status");

-- CreateIndex
CREATE INDEX "Appointment_patientId_status_date_idx" ON "Appointment"("patientId", "status", "date");

-- CreateIndex
CREATE INDEX "Appointment_doctorId_date_status_idx" ON "Appointment"("doctorId", "date", "status");

-- CreateIndex
CREATE INDEX "Prescription_patientId_idx" ON "Prescription"("patientId");

-- CreateIndex
CREATE INDEX "Prescription_doctorId_idx" ON "Prescription"("doctorId");

-- CreateIndex
CREATE INDEX "Prescription_therapistId_idx" ON "Prescription"("therapistId");

-- CreateIndex
CREATE INDEX "Prescription_createdAt_idx" ON "Prescription"("createdAt");

-- CreateIndex
CREATE INDEX "Prescription_branchId_idx" ON "Prescription"("branchId");

-- CreateIndex
CREATE INDEX "Prescription_appointmentId_idx" ON "Prescription"("appointmentId");

-- CreateIndex
CREATE INDEX "Prescription_packageId_idx" ON "Prescription"("packageId");

-- CreateIndex
CREATE INDEX "Prescription_journeyId_idx" ON "Prescription"("journeyId");

-- CreateIndex
CREATE INDEX "Prescription_discontinuedAt_expectedEndDate_idx" ON "Prescription"("discontinuedAt", "expectedEndDate");

-- CreateIndex
CREATE INDEX "Availability_therapistId_idx" ON "Availability"("therapistId");

-- CreateIndex
CREATE INDEX "Availability_therapistId_dayOfWeek_idx" ON "Availability"("therapistId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "Availability_therapistId_isApproved_idx" ON "Availability"("therapistId", "isApproved");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification"("userId", "isRead");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_relatedId_type_idx" ON "Notification"("relatedId", "type");

-- CreateIndex
CREATE INDEX "Notification_userId_type_createdAt_idx" ON "Notification"("userId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_notificationId_idx" ON "NotificationDelivery"("notificationId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationDelivery_channel_status_idx" ON "NotificationDelivery"("channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE INDEX "Document_patientId_idx" ON "Document"("patientId");

-- CreateIndex
CREATE INDEX "Document_category_idx" ON "Document"("category");

-- CreateIndex
CREATE INDEX "Document_triageSessionId_idx" ON "Document"("triageSessionId");

-- CreateIndex
CREATE INDEX "Journey_patientId_status_idx" ON "Journey"("patientId", "status");

-- CreateIndex
CREATE INDEX "Journey_doctorId_idx" ON "Journey"("doctorId");

-- CreateIndex
CREATE INDEX "MedicationLog_journeyId_date_idx" ON "MedicationLog"("journeyId", "date");

-- CreateIndex
CREATE INDEX "MedicationLog_prescriptionId_idx" ON "MedicationLog"("prescriptionId");

-- CreateIndex
CREATE INDEX "BulkOperation_initiatedBy_idx" ON "BulkOperation"("initiatedBy");

-- CreateIndex
CREATE INDEX "BulkOperation_status_idx" ON "BulkOperation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_transactionId_key" ON "Payment"("transactionId");

-- CreateIndex
CREATE INDEX "Payment_patientId_idx" ON "Payment"("patientId");

-- CreateIndex
CREATE INDEX "Payment_status_idx" ON "Payment"("status");

-- CreateIndex
CREATE INDEX "Payment_createdAt_idx" ON "Payment"("createdAt");

-- CreateIndex
CREATE INDEX "Payment_branchId_idx" ON "Payment"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Medicine_sku_key" ON "Medicine"("sku");

-- CreateIndex
CREATE INDEX "Medicine_name_idx" ON "Medicine"("name");

-- CreateIndex
CREATE INDEX "MedicineStock_medicineId_idx" ON "MedicineStock"("medicineId");

-- CreateIndex
CREATE INDEX "MedicineStock_expiryDate_idx" ON "MedicineStock"("expiryDate");

-- CreateIndex
CREATE INDEX "MedicineStock_branchId_idx" ON "MedicineStock"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "MedicineStock_medicineId_branchId_batchNumber_key" ON "MedicineStock"("medicineId", "branchId", "batchNumber");

-- CreateIndex
CREATE INDEX "PharmacyDispense_patientId_idx" ON "PharmacyDispense"("patientId");

-- CreateIndex
CREATE INDEX "PharmacyDispense_createdAt_idx" ON "PharmacyDispense"("createdAt");

-- CreateIndex
CREATE INDEX "PharmacyDispense_branchId_idx" ON "PharmacyDispense"("branchId");

-- CreateIndex
CREATE INDEX "PharmacyDispense_dispensedBy_idx" ON "PharmacyDispense"("dispensedBy");

-- CreateIndex
CREATE INDEX "PharmacyOrder_patientId_idx" ON "PharmacyOrder"("patientId");

-- CreateIndex
CREATE INDEX "PharmacyOrder_status_idx" ON "PharmacyOrder"("status");

-- CreateIndex
CREATE INDEX "PharmacyOrder_urgency_idx" ON "PharmacyOrder"("urgency");

-- CreateIndex
CREATE INDEX "PharmacyOrder_createdAt_idx" ON "PharmacyOrder"("createdAt");

-- CreateIndex
CREATE INDEX "PharmacyOrder_branchId_idx" ON "PharmacyOrder"("branchId");

-- CreateIndex
CREATE INDEX "Invoice_patientId_idx" ON "Invoice"("patientId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_branchId_idx" ON "Invoice"("branchId");

-- CreateIndex
CREATE INDEX "TriageSession_patientId_idx" ON "TriageSession"("patientId");

-- CreateIndex
CREATE INDEX "TriageSession_branchId_idx" ON "TriageSession"("branchId");

-- CreateIndex
CREATE INDEX "TriageSession_urgencyLevel_idx" ON "TriageSession"("urgencyLevel");

-- CreateIndex
CREATE INDEX "TriageSession_reviewedByUserId_idx" ON "TriageSession"("reviewedByUserId");

-- CreateIndex
CREATE INDEX "TriageOverride_triageSessionId_idx" ON "TriageOverride"("triageSessionId");

-- CreateIndex
CREATE INDEX "TriageOverride_reviewerUserId_idx" ON "TriageOverride"("reviewerUserId");

-- CreateIndex
CREATE INDEX "TriageOverride_createdAt_idx" ON "TriageOverride"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SpecialtyRoute_specialty_key" ON "SpecialtyRoute"("specialty");

-- CreateIndex
CREATE INDEX "SpecialtyRoute_isActive_priority_idx" ON "SpecialtyRoute"("isActive", "priority");

-- CreateIndex
CREATE INDEX "Conversation_patientId_idx" ON "Conversation"("patientId");

-- CreateIndex
CREATE INDEX "Conversation_doctorId_idx" ON "Conversation"("doctorId");

-- CreateIndex
CREATE INDEX "Conversation_therapistId_idx" ON "Conversation"("therapistId");

-- CreateIndex
CREATE INDEX "Conversation_pharmacistId_idx" ON "Conversation"("pharmacistId");

-- CreateIndex
CREATE INDEX "Conversation_branchId_idx" ON "Conversation"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_patientId_doctorId_key" ON "Conversation"("patientId", "doctorId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_patientId_therapistId_key" ON "Conversation"("patientId", "therapistId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_patientId_pharmacistId_key" ON "Conversation"("patientId", "pharmacistId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StaffThread_directKey_key" ON "StaffThread"("directKey");

-- CreateIndex
CREATE INDEX "StaffThread_hospitalId_idx" ON "StaffThread"("hospitalId");

-- CreateIndex
CREATE INDEX "StaffThread_branchId_idx" ON "StaffThread"("branchId");

-- CreateIndex
CREATE INDEX "StaffThread_kind_idx" ON "StaffThread"("kind");

-- CreateIndex
CREATE INDEX "StaffThread_updatedAt_idx" ON "StaffThread"("updatedAt");

-- CreateIndex
CREATE INDEX "StaffThreadMember_userId_removedAt_idx" ON "StaffThreadMember"("userId", "removedAt");

-- CreateIndex
CREATE INDEX "StaffThreadMember_threadId_removedAt_idx" ON "StaffThreadMember"("threadId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StaffThreadMember_threadId_userId_key" ON "StaffThreadMember"("threadId", "userId");

-- CreateIndex
CREATE INDEX "StaffMessage_threadId_createdAt_idx" ON "StaffMessage"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");

-- CreateIndex
CREATE INDEX "FeatureFlag_key_idx" ON "FeatureFlag"("key");

-- CreateIndex
CREATE INDEX "RefillRequest_prescriptionId_idx" ON "RefillRequest"("prescriptionId");

-- CreateIndex
CREATE INDEX "RefillRequest_patientId_idx" ON "RefillRequest"("patientId");

-- CreateIndex
CREATE INDEX "RefillRequest_status_idx" ON "RefillRequest"("status");

-- CreateIndex
CREATE INDEX "RefillRequest_requestedById_idx" ON "RefillRequest"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referralCode_key" ON "Referral"("referralCode");

-- CreateIndex
CREATE INDEX "Referral_referrerId_idx" ON "Referral"("referrerId");

-- CreateIndex
CREATE INDEX "Referral_referralCode_idx" ON "Referral"("referralCode");

-- CreateIndex
CREATE INDEX "Referral_status_idx" ON "Referral"("status");

-- CreateIndex
CREATE INDEX "LeaderboardAudit_participantId_idx" ON "LeaderboardAudit"("participantId");

-- CreateIndex
CREATE INDEX "LeaderboardAudit_calculationDate_idx" ON "LeaderboardAudit"("calculationDate");

-- CreateIndex
CREATE UNIQUE INDEX "RetentionChecklist_appointmentId_key" ON "RetentionChecklist"("appointmentId");

-- CreateIndex
CREATE INDEX "RetentionChecklist_patientId_idx" ON "RetentionChecklist"("patientId");

-- CreateIndex
CREATE INDEX "RetentionChecklist_appointmentId_idx" ON "RetentionChecklist"("appointmentId");

-- CreateIndex
CREATE INDEX "RetentionChecklist_clinicianId_idx" ON "RetentionChecklist"("clinicianId");

-- CreateIndex
CREATE INDEX "RetentionChecklist_branchId_idx" ON "RetentionChecklist"("branchId");

-- CreateIndex
CREATE INDEX "RetentionChecklist_clinicianId_createdAt_idx" ON "RetentionChecklist"("clinicianId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentFeedback_appointmentId_key" ON "AppointmentFeedback"("appointmentId");

-- CreateIndex
CREATE INDEX "AppointmentFeedback_patientId_idx" ON "AppointmentFeedback"("patientId");

-- CreateIndex
CREATE INDEX "AppointmentFeedback_appointmentId_idx" ON "AppointmentFeedback"("appointmentId");

-- CreateIndex
CREATE INDEX "AppointmentFeedback_branchId_idx" ON "AppointmentFeedback"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultationFeedback_appointmentId_key" ON "ConsultationFeedback"("appointmentId");

-- CreateIndex
CREATE INDEX "ConsultationFeedback_doctorId_idx" ON "ConsultationFeedback"("doctorId");

-- CreateIndex
CREATE INDEX "ConsultationFeedback_clinicianId_idx" ON "ConsultationFeedback"("clinicianId");

-- CreateIndex
CREATE INDEX "ConsultationFeedback_patientId_idx" ON "ConsultationFeedback"("patientId");

-- CreateIndex
CREATE INDEX "ConsultationFeedback_branchId_idx" ON "ConsultationFeedback"("branchId");

-- CreateIndex
CREATE INDEX "ConsultationFeedback_createdAt_idx" ON "ConsultationFeedback"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JourneyFeedback_journeyId_key" ON "JourneyFeedback"("journeyId");

-- CreateIndex
CREATE INDEX "JourneyFeedback_leadDoctorId_idx" ON "JourneyFeedback"("leadDoctorId");

-- CreateIndex
CREATE INDEX "JourneyFeedback_primaryClinicianId_idx" ON "JourneyFeedback"("primaryClinicianId");

-- CreateIndex
CREATE INDEX "JourneyFeedback_patientId_idx" ON "JourneyFeedback"("patientId");

-- CreateIndex
CREATE INDEX "JourneyFeedback_branchId_idx" ON "JourneyFeedback"("branchId");

-- CreateIndex
CREATE INDEX "JourneyFeedback_completedAt_idx" ON "JourneyFeedback"("completedAt");

-- CreateIndex
CREATE INDEX "JourneyFeedback_completedAt_reminderSentAt_idx" ON "JourneyFeedback"("completedAt", "reminderSentAt");

-- CreateIndex
CREATE UNIQUE INDEX "ThankYouCard_feedbackId_key" ON "ThankYouCard"("feedbackId");

-- CreateIndex
CREATE INDEX "ThankYouCard_recipientDoctorId_visibility_createdAt_idx" ON "ThankYouCard"("recipientDoctorId", "visibility", "createdAt");

-- CreateIndex
CREATE INDEX "TreatmentJourney_patientId_idx" ON "TreatmentJourney"("patientId");

-- CreateIndex
CREATE INDEX "TreatmentJourney_doctorId_idx" ON "TreatmentJourney"("doctorId");

-- CreateIndex
CREATE INDEX "TreatmentJourney_branchId_idx" ON "TreatmentJourney"("branchId");

-- CreateIndex
CREATE INDEX "TreatmentJourney_status_idx" ON "TreatmentJourney"("status");

-- CreateIndex
CREATE INDEX "JourneyPhase_journeyId_idx" ON "JourneyPhase"("journeyId");

-- CreateIndex
CREATE INDEX "PhaseTask_phaseId_idx" ON "PhaseTask"("phaseId");

-- CreateIndex
CREATE INDEX "TaskCompletion_taskId_idx" ON "TaskCompletion"("taskId");

-- CreateIndex
CREATE INDEX "TaskCompletion_patientId_idx" ON "TaskCompletion"("patientId");

-- CreateIndex
CREATE INDEX "JourneyMilestone_journeyId_idx" ON "JourneyMilestone"("journeyId");

-- CreateIndex
CREATE INDEX "PatientVital_journeyId_idx" ON "PatientVital"("journeyId");

-- CreateIndex
CREATE INDEX "PatientVital_patientId_idx" ON "PatientVital"("patientId");

-- CreateIndex
CREATE INDEX "PatientVital_type_recordedAt_idx" ON "PatientVital"("type", "recordedAt");

-- CreateIndex
CREATE INDEX "PrescribedVital_patientId_active_idx" ON "PrescribedVital"("patientId", "active");

-- CreateIndex
CREATE INDEX "PrescribedVital_prescribedById_idx" ON "PrescribedVital"("prescribedById");

-- CreateIndex
CREATE UNIQUE INDEX "PrescribedVital_patientId_vitalType_key" ON "PrescribedVital"("patientId", "vitalType");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_code_key" ON "Badge"("code");

-- CreateIndex
CREATE INDEX "UserBadge_userId_idx" ON "UserBadge"("userId");

-- CreateIndex
CREATE INDEX "UserBadge_badgeId_idx" ON "UserBadge"("badgeId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBadge_userId_badgeId_key" ON "UserBadge"("userId", "badgeId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicianStreak_participantId_key" ON "ClinicianStreak"("participantId");

-- CreateIndex
CREATE INDEX "ClinicianStreak_participantId_idx" ON "ClinicianStreak"("participantId");

-- CreateIndex
CREATE INDEX "BranchCompetition_isActive_endDate_idx" ON "BranchCompetition"("isActive", "endDate");

-- CreateIndex
CREATE INDEX "BranchCompetitionEntry_competitionId_idx" ON "BranchCompetitionEntry"("competitionId");

-- CreateIndex
CREATE INDEX "BranchCompetitionEntry_branchId_idx" ON "BranchCompetitionEntry"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "BranchCompetitionEntry_competitionId_branchId_key" ON "BranchCompetitionEntry"("competitionId", "branchId");

-- CreateIndex
CREATE INDEX "DailyChallenge_activeDate_idx" ON "DailyChallenge"("activeDate");

-- CreateIndex
CREATE INDEX "PatientChallengeCompletion_patientId_idx" ON "PatientChallengeCompletion"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientChallengeCompletion_patientId_challengeId_key" ON "PatientChallengeCompletion"("patientId", "challengeId");

-- CreateIndex
CREATE INDEX "ZenPointsLedger_patientId_idx" ON "ZenPointsLedger"("patientId");

-- CreateIndex
CREATE INDEX "ZenPointsLedger_patientId_createdAt_idx" ON "ZenPointsLedger"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "ZenPointsLedger_action_idx" ON "ZenPointsLedger"("action");

-- CreateIndex
CREATE UNIQUE INDEX "PatientStreak_patientId_key" ON "PatientStreak"("patientId");

-- CreateIndex
CREATE INDEX "PatientStreak_patientId_idx" ON "PatientStreak"("patientId");

-- CreateIndex
CREATE INDEX "DoshaForecast_patientId_generatedAt_idx" ON "DoshaForecast"("patientId", "generatedAt");

-- CreateIndex
CREATE INDEX "NudgeLog_patientId_sentAt_idx" ON "NudgeLog"("patientId", "sentAt");

-- CreateIndex
CREATE INDEX "GamificationAnomaly_participantId_idx" ON "GamificationAnomaly"("participantId");

-- CreateIndex
CREATE INDEX "GamificationAnomaly_anomalyType_idx" ON "GamificationAnomaly"("anomalyType");

-- CreateIndex
CREATE INDEX "GamificationAnomaly_resolved_idx" ON "GamificationAnomaly"("resolved");

-- CreateIndex
CREATE INDEX "AdaptiveTarget_participantId_idx" ON "AdaptiveTarget"("participantId");

-- CreateIndex
CREATE INDEX "AdaptiveTarget_effectiveFrom_idx" ON "AdaptiveTarget"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "AdaptiveTarget_participantId_metric_effectiveFrom_key" ON "AdaptiveTarget"("participantId", "metric", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ResourceSharing_userId_idx" ON "ResourceSharing"("userId");

-- CreateIndex
CREATE INDEX "ResourceSharing_fromBranchId_idx" ON "ResourceSharing"("fromBranchId");

-- CreateIndex
CREATE INDEX "ResourceSharing_toBranchId_idx" ON "ResourceSharing"("toBranchId");

-- CreateIndex
CREATE INDEX "ResourceSharing_date_idx" ON "ResourceSharing"("date");

-- CreateIndex
CREATE INDEX "ResourceSharing_status_idx" ON "ResourceSharing"("status");

-- CreateIndex
CREATE INDEX "ResourceSharing_createdById_idx" ON "ResourceSharing"("createdById");

-- CreateIndex
CREATE INDEX "StockTransfer_fromBranchId_idx" ON "StockTransfer"("fromBranchId");

-- CreateIndex
CREATE INDEX "StockTransfer_toBranchId_idx" ON "StockTransfer"("toBranchId");

-- CreateIndex
CREATE INDEX "StockTransfer_medicineId_idx" ON "StockTransfer"("medicineId");

-- CreateIndex
CREATE INDEX "StockTransfer_status_idx" ON "StockTransfer"("status");

-- CreateIndex
CREATE INDEX "StaffActivity_userId_idx" ON "StaffActivity"("userId");

-- CreateIndex
CREATE INDEX "StaffActivity_branchId_idx" ON "StaffActivity"("branchId");

-- CreateIndex
CREATE INDEX "StaffActivity_activityType_idx" ON "StaffActivity"("activityType");

-- CreateIndex
CREATE INDEX "StaffActivity_startedAt_idx" ON "StaffActivity"("startedAt");

-- CreateIndex
CREATE INDEX "PerformanceScorecard_clinicianId_idx" ON "PerformanceScorecard"("clinicianId");

-- CreateIndex
CREATE INDEX "PerformanceScorecard_period_idx" ON "PerformanceScorecard"("period");

-- CreateIndex
CREATE INDEX "PerformanceScorecard_overallScore_idx" ON "PerformanceScorecard"("overallScore");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceScorecard_clinicianId_period_periodType_key" ON "PerformanceScorecard"("clinicianId", "period", "periodType");

-- CreateIndex
CREATE INDEX "StaffAttendance_userId_idx" ON "StaffAttendance"("userId");

-- CreateIndex
CREATE INDEX "StaffAttendance_branchId_idx" ON "StaffAttendance"("branchId");

-- CreateIndex
CREATE INDEX "StaffAttendance_date_idx" ON "StaffAttendance"("date");

-- CreateIndex
CREATE INDEX "StaffAttendance_status_idx" ON "StaffAttendance"("status");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAttendance_userId_date_key" ON "StaffAttendance"("userId", "date");

-- CreateIndex
CREATE INDEX "StaffSkill_userId_idx" ON "StaffSkill"("userId");

-- CreateIndex
CREATE INDEX "StaffSkill_skillType_idx" ON "StaffSkill"("skillType");

-- CreateIndex
CREATE INDEX "StaffSkill_skillName_idx" ON "StaffSkill"("skillName");

-- CreateIndex
CREATE UNIQUE INDEX "StaffSkill_userId_skillType_skillName_key" ON "StaffSkill"("userId", "skillType", "skillName");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicianXP_userId_key" ON "ClinicianXP"("userId");

-- CreateIndex
CREATE INDEX "ClinicianXP_totalXP_idx" ON "ClinicianXP"("totalXP");

-- CreateIndex
CREATE INDEX "ClinicianXP_level_idx" ON "ClinicianXP"("level");

-- CreateIndex
CREATE INDEX "XPLedger_userId_idx" ON "XPLedger"("userId");

-- CreateIndex
CREATE INDEX "XPLedger_userId_createdAt_idx" ON "XPLedger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "XPLedger_action_idx" ON "XPLedger"("action");

-- CreateIndex
CREATE INDEX "SeasonalChallenge_isActive_endDate_idx" ON "SeasonalChallenge"("isActive", "endDate");

-- CreateIndex
CREATE INDEX "SeasonalChallenge_startDate_endDate_idx" ON "SeasonalChallenge"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "SeasonalChallengeProgress_participantId_idx" ON "SeasonalChallengeProgress"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonalChallengeProgress_challengeId_participantId_key" ON "SeasonalChallengeProgress"("challengeId", "participantId");

-- CreateIndex
CREATE INDEX "RewardItem_category_idx" ON "RewardItem"("category");

-- CreateIndex
CREATE INDEX "RewardItem_isActive_idx" ON "RewardItem"("isActive");

-- CreateIndex
CREATE INDEX "RewardRedemption_userId_idx" ON "RewardRedemption"("userId");

-- CreateIndex
CREATE INDEX "RewardRedemption_rewardId_idx" ON "RewardRedemption"("rewardId");

-- CreateIndex
CREATE INDEX "RewardRedemption_status_idx" ON "RewardRedemption"("status");

-- CreateIndex
CREATE INDEX "MentorSession_mentorId_idx" ON "MentorSession"("mentorId");

-- CreateIndex
CREATE INDEX "MentorSession_menteeId_idx" ON "MentorSession"("menteeId");

-- CreateIndex
CREATE INDEX "MentorSession_date_idx" ON "MentorSession"("date");

-- CreateIndex
CREATE INDEX "HealthQuest_isActive_idx" ON "HealthQuest"("isActive");

-- CreateIndex
CREATE INDEX "HealthQuest_difficulty_idx" ON "HealthQuest"("difficulty");

-- CreateIndex
CREATE INDEX "PatientQuestProgress_patientId_idx" ON "PatientQuestProgress"("patientId");

-- CreateIndex
CREATE INDEX "PatientQuestProgress_status_idx" ON "PatientQuestProgress"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PatientQuestProgress_patientId_questId_key" ON "PatientQuestProgress"("patientId", "questId");

-- CreateIndex
CREATE UNIQUE INDEX "HealthAvatar_patientId_key" ON "HealthAvatar"("patientId");

-- CreateIndex
CREATE INDEX "HealthAvatar_patientId_idx" ON "HealthAvatar"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientFamily_inviteCode_key" ON "PatientFamily"("inviteCode");

-- CreateIndex
CREATE INDEX "PatientFamily_createdById_idx" ON "PatientFamily"("createdById");

-- CreateIndex
CREATE INDEX "PatientFamily_inviteCode_idx" ON "PatientFamily"("inviteCode");

-- CreateIndex
CREATE INDEX "PatientFamilyMember_patientId_idx" ON "PatientFamilyMember"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientFamilyMember_familyId_patientId_key" ON "PatientFamilyMember"("familyId", "patientId");

-- CreateIndex
CREATE INDEX "HealthContent_type_idx" ON "HealthContent"("type");

-- CreateIndex
CREATE INDEX "HealthContent_requiredLevel_idx" ON "HealthContent"("requiredLevel");

-- CreateIndex
CREATE INDEX "HealthContent_isActive_idx" ON "HealthContent"("isActive");

-- CreateIndex
CREATE INDEX "ContentUnlock_patientId_idx" ON "ContentUnlock"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentUnlock_patientId_contentId_key" ON "ContentUnlock"("patientId", "contentId");

-- CreateIndex
CREATE INDEX "Announcement_authorId_idx" ON "Announcement"("authorId");

-- CreateIndex
CREATE INDEX "Announcement_createdAt_idx" ON "Announcement"("createdAt");

-- CreateIndex
CREATE INDEX "Announcement_isPinned_idx" ON "Announcement"("isPinned");

-- CreateIndex
CREATE INDEX "AnnouncementRead_userId_idx" ON "AnnouncementRead"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementRead_announcementId_userId_key" ON "AnnouncementRead"("announcementId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "HandoffNote_sourceAppointmentId_key" ON "HandoffNote"("sourceAppointmentId");

-- CreateIndex
CREATE INDEX "HandoffNote_patientId_idx" ON "HandoffNote"("patientId");

-- CreateIndex
CREATE INDEX "HandoffNote_fromClinicianId_idx" ON "HandoffNote"("fromClinicianId");

-- CreateIndex
CREATE INDEX "HandoffNote_toClinicianId_idx" ON "HandoffNote"("toClinicianId");

-- CreateIndex
CREATE INDEX "HandoffNote_toBranchId_idx" ON "HandoffNote"("toBranchId");

-- CreateIndex
CREATE INDEX "HandoffNote_isRead_idx" ON "HandoffNote"("isRead");

-- CreateIndex
CREATE INDEX "HandoffNote_status_idx" ON "HandoffNote"("status");

-- CreateIndex
CREATE INDEX "HandoffNote_fromClinicianId_status_idx" ON "HandoffNote"("fromClinicianId", "status");

-- CreateIndex
CREATE INDEX "TherapistSessionNote_therapistId_idx" ON "TherapistSessionNote"("therapistId");

-- CreateIndex
CREATE INDEX "TherapistSessionNote_patientId_idx" ON "TherapistSessionNote"("patientId");

-- CreateIndex
CREATE INDEX "TherapistSessionNote_appointmentId_idx" ON "TherapistSessionNote"("appointmentId");

-- CreateIndex
CREATE INDEX "TherapistSessionNote_patientId_isVisibleToDoctor_idx" ON "TherapistSessionNote"("patientId", "isVisibleToDoctor");

-- CreateIndex
CREATE INDEX "TherapistSessionNote_therapistId_patientId_idx" ON "TherapistSessionNote"("therapistId", "patientId");

-- CreateIndex
CREATE INDEX "TherapyOutcome_patientId_sessionDate_idx" ON "TherapyOutcome"("patientId", "sessionDate");

-- CreateIndex
CREATE INDEX "TherapyOutcome_therapistId_idx" ON "TherapyOutcome"("therapistId");

-- CreateIndex
CREATE INDEX "TherapyOutcome_appointmentId_idx" ON "TherapyOutcome"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "VisitSummary_appointmentId_key" ON "VisitSummary"("appointmentId");

-- CreateIndex
CREATE INDEX "VisitSummary_patientId_idx" ON "VisitSummary"("patientId");

-- CreateIndex
CREATE INDEX "VisitSummary_clinicianId_idx" ON "VisitSummary"("clinicianId");

-- CreateIndex
CREATE INDEX "VisitSummary_appointmentId_idx" ON "VisitSummary"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Hospital_slug_key" ON "Hospital"("slug");

-- CreateIndex
CREATE INDEX "Hospital_status_idx" ON "Hospital"("status");

-- CreateIndex
CREATE INDEX "Hospital_plan_idx" ON "Hospital"("plan");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureRegistry_key_key" ON "FeatureRegistry"("key");

-- CreateIndex
CREATE INDEX "FeatureRegistry_phase_idx" ON "FeatureRegistry"("phase");

-- CreateIndex
CREATE INDEX "FeatureRegistry_minPlan_idx" ON "FeatureRegistry"("minPlan");

-- CreateIndex
CREATE INDEX "HospitalFeatureFlag_featureKey_idx" ON "HospitalFeatureFlag"("featureKey");

-- CreateIndex
CREATE INDEX "HospitalFeatureFlag_hospitalId_idx" ON "HospitalFeatureFlag"("hospitalId");

-- CreateIndex
CREATE UNIQUE INDEX "HospitalFeatureFlag_hospitalId_featureKey_key" ON "HospitalFeatureFlag"("hospitalId", "featureKey");

-- CreateIndex
CREATE INDEX "SuperAdminAuditLog_superAdminId_idx" ON "SuperAdminAuditLog"("superAdminId");

-- CreateIndex
CREATE INDEX "SuperAdminAuditLog_hospitalId_idx" ON "SuperAdminAuditLog"("hospitalId");

-- CreateIndex
CREATE INDEX "SuperAdminAuditLog_action_idx" ON "SuperAdminAuditLog"("action");

-- CreateIndex
CREATE INDEX "SuperAdminAuditLog_createdAt_idx" ON "SuperAdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "TherapyRoom_branchId_idx" ON "TherapyRoom"("branchId");

-- CreateIndex
CREATE INDEX "TherapyRoom_type_idx" ON "TherapyRoom"("type");

-- CreateIndex
CREATE UNIQUE INDEX "TherapyRoomBooking_appointmentId_key" ON "TherapyRoomBooking"("appointmentId");

-- CreateIndex
CREATE INDEX "TherapyRoomBooking_roomId_date_idx" ON "TherapyRoomBooking"("roomId", "date");

-- CreateIndex
CREATE INDEX "TherapyRoomBooking_date_idx" ON "TherapyRoomBooking"("date");

-- CreateIndex
CREATE INDEX "DietPrescription_patientId_idx" ON "DietPrescription"("patientId");

-- CreateIndex
CREATE INDEX "DietPrescription_doctorId_idx" ON "DietPrescription"("doctorId");

-- CreateIndex
CREATE INDEX "DietPrescription_isActive_idx" ON "DietPrescription"("isActive");

-- CreateIndex
CREATE INDEX "DietPrescription_packageId_idx" ON "DietPrescription"("packageId");

-- CreateIndex
CREATE INDEX "DietPackage_hospitalId_idx" ON "DietPackage"("hospitalId");

-- CreateIndex
CREATE INDEX "DietPackage_status_idx" ON "DietPackage"("status");

-- CreateIndex
CREATE INDEX "DietPackage_createdById_idx" ON "DietPackage"("createdById");

-- CreateIndex
CREATE INDEX "DietPackage_isActive_idx" ON "DietPackage"("isActive");

-- CreateIndex
CREATE INDEX "DietPackageMeal_packageId_idx" ON "DietPackageMeal"("packageId");

-- CreateIndex
CREATE INDEX "DietMeal_dietPrescriptionId_idx" ON "DietMeal"("dietPrescriptionId");

-- CreateIndex
CREATE INDEX "DietAdherenceLog_dietPrescriptionId_date_idx" ON "DietAdherenceLog"("dietPrescriptionId", "date");

-- CreateIndex
CREATE INDEX "DietAdherenceLog_patientId_date_idx" ON "DietAdherenceLog"("patientId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DietAdherenceLog_dietPrescriptionId_patientId_mealTime_date_key" ON "DietAdherenceLog"("dietPrescriptionId", "patientId", "mealTime", "date");

-- CreateIndex
CREATE INDEX "ClinicalPhoto_patientId_idx" ON "ClinicalPhoto"("patientId");

-- CreateIndex
CREATE INDEX "ClinicalPhoto_journeyId_idx" ON "ClinicalPhoto"("journeyId");

-- CreateIndex
CREATE INDEX "ClinicalPhoto_category_idx" ON "ClinicalPhoto"("category");

-- CreateIndex
CREATE INDEX "TherapistSkill_skill_idx" ON "TherapistSkill"("skill");

-- CreateIndex
CREATE UNIQUE INDEX "TherapistSkill_therapistId_skill_key" ON "TherapistSkill"("therapistId", "skill");

-- CreateIndex
CREATE INDEX "TreatmentPackage_branchId_idx" ON "TreatmentPackage"("branchId");

-- CreateIndex
CREATE INDEX "TreatmentPackage_isActive_idx" ON "TreatmentPackage"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PackageEnrolment_invoiceId_key" ON "PackageEnrolment"("invoiceId");

-- CreateIndex
CREATE INDEX "PackageEnrolment_patientId_idx" ON "PackageEnrolment"("patientId");

-- CreateIndex
CREATE INDEX "PackageEnrolment_packageId_idx" ON "PackageEnrolment"("packageId");

-- CreateIndex
CREATE INDEX "PackageEnrolment_status_idx" ON "PackageEnrolment"("status");

-- CreateIndex
CREATE INDEX "PackageSessionLog_enrolmentId_idx" ON "PackageSessionLog"("enrolmentId");

-- CreateIndex
CREATE INDEX "PackageSessionLog_conductedById_idx" ON "PackageSessionLog"("conductedById");

-- CreateIndex
CREATE INDEX "GroupSession_branchId_date_idx" ON "GroupSession"("branchId", "date");

-- CreateIndex
CREATE INDEX "GroupSession_therapistId_date_idx" ON "GroupSession"("therapistId", "date");

-- CreateIndex
CREATE INDEX "GroupSession_status_idx" ON "GroupSession"("status");

-- CreateIndex
CREATE INDEX "GroupSession_createdById_idx" ON "GroupSession"("createdById");

-- CreateIndex
CREATE INDEX "Todo_assignedToId_status_idx" ON "Todo"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "Todo_createdById_status_idx" ON "Todo"("createdById", "status");

-- CreateIndex
CREATE INDEX "Todo_branchId_status_idx" ON "Todo"("branchId", "status");

-- CreateIndex
CREATE INDEX "Todo_dueDate_idx" ON "Todo"("dueDate");

-- CreateIndex
CREATE INDEX "Todo_status_dueDate_idx" ON "Todo"("status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "SelfExamSubmission_triageSessionId_key" ON "SelfExamSubmission"("triageSessionId");

-- CreateIndex
CREATE INDEX "SelfExamSubmission_patientId_createdAt_idx" ON "SelfExamSubmission"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "SelfExamSubmission_branchId_status_idx" ON "SelfExamSubmission"("branchId", "status");

-- CreateIndex
CREATE INDEX "SelfExamSubmission_hospitalId_status_idx" ON "SelfExamSubmission"("hospitalId", "status");

-- CreateIndex
CREATE INDEX "SelfExamSubmission_appointmentId_idx" ON "SelfExamSubmission"("appointmentId");

-- CreateIndex
CREATE INDEX "SelfExamSubmission_status_idx" ON "SelfExamSubmission"("status");

-- CreateIndex
CREATE INDEX "SymptomHistoryEntry_painZone_idx" ON "SymptomHistoryEntry"("painZone");

-- CreateIndex
CREATE UNIQUE INDEX "SymptomHistoryEntry_submissionId_painZone_key" ON "SymptomHistoryEntry"("submissionId", "painZone");

-- CreateIndex
CREATE UNIQUE INDEX "TongueObservation_checkInId_key" ON "TongueObservation"("checkInId");

-- CreateIndex
CREATE INDEX "TongueObservation_patientId_observedAt_idx" ON "TongueObservation"("patientId", "observedAt");

-- CreateIndex
CREATE INDEX "TongueObservation_patientId_observedOn_idx" ON "TongueObservation"("patientId", "observedOn");

-- CreateIndex
CREATE INDEX "StoolLog_patientId_observedOn_idx" ON "StoolLog"("patientId", "observedOn");

-- CreateIndex
CREATE UNIQUE INDEX "StoolLog_submissionId_dayIndex_key" ON "StoolLog"("submissionId", "dayIndex");

-- CreateIndex
CREATE INDEX "UrineLog_patientId_observedOn_idx" ON "UrineLog"("patientId", "observedOn");

-- CreateIndex
CREATE UNIQUE INDEX "UrineLog_submissionId_dayIndex_key" ON "UrineLog"("submissionId", "dayIndex");

-- CreateIndex
CREATE UNIQUE INDEX "RoMMeasurement_submissionId_joint_direction_key" ON "RoMMeasurement"("submissionId", "joint", "direction");

-- CreateIndex
CREATE UNIQUE INDEX "PhysicalObservation_submissionId_observationType_key" ON "PhysicalObservation"("submissionId", "observationType");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceObservation_submissionId_dayIndex_key" ON "VoiceObservation"("submissionId", "dayIndex");

-- CreateIndex
CREATE UNIQUE INDEX "DigestiveProfile_submissionId_key" ON "DigestiveProfile"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "LifestyleContext_submissionId_key" ON "LifestyleContext"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "ConstitutionProfile_patientId_key" ON "ConstitutionProfile"("patientId");

-- CreateIndex
CREATE INDEX "SelfExamProtocolOverride_hospitalId_idx" ON "SelfExamProtocolOverride"("hospitalId");

-- CreateIndex
CREATE UNIQUE INDEX "SelfExamProtocolOverride_hospitalId_painZone_key" ON "SelfExamProtocolOverride"("hospitalId", "painZone");

-- CreateIndex
CREATE INDEX "MessageTemplate_hospitalId_idx" ON "MessageTemplate"("hospitalId");

-- CreateIndex
CREATE INDEX "MessageTemplate_hospitalId_category_idx" ON "MessageTemplate"("hospitalId", "category");

-- CreateIndex
CREATE INDEX "MessageTemplate_isActive_idx" ON "MessageTemplate"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_hospitalId_name_key" ON "MessageTemplate"("hospitalId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderSetting_hospitalId_key" ON "ReminderSetting"("hospitalId");

-- CreateIndex
CREATE INDEX "ReminderDeliveryLog_hospitalId_kind_idx" ON "ReminderDeliveryLog"("hospitalId", "kind");

-- CreateIndex
CREATE INDEX "ReminderDeliveryLog_appointmentId_idx" ON "ReminderDeliveryLog"("appointmentId");

-- CreateIndex
CREATE INDEX "ReminderDeliveryLog_patientUserId_idx" ON "ReminderDeliveryLog"("patientUserId");

-- CreateIndex
CREATE INDEX "ReminderDeliveryLog_createdAt_idx" ON "ReminderDeliveryLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppointmentFollowUp_appointmentId_key" ON "AppointmentFollowUp"("appointmentId");

-- CreateIndex
CREATE INDEX "AppointmentFollowUp_patientId_status_idx" ON "AppointmentFollowUp"("patientId", "status");

-- CreateIndex
CREATE INDEX "AppointmentFollowUp_dueDate_status_idx" ON "AppointmentFollowUp"("dueDate", "status");

-- CreateIndex
CREATE INDEX "AppointmentFollowUp_status_idx" ON "AppointmentFollowUp"("status");

-- CreateIndex
CREATE INDEX "AppointmentFollowUp_createdById_idx" ON "AppointmentFollowUp"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "PatientCriticalFlag_patientId_key" ON "PatientCriticalFlag"("patientId");

-- CreateIndex
CREATE INDEX "PatientCriticalFlag_status_lastDetectedAt_idx" ON "PatientCriticalFlag"("status", "lastDetectedAt");

-- CreateIndex
CREATE INDEX "PatientCriticalFlag_branchId_status_idx" ON "PatientCriticalFlag"("branchId", "status");

-- CreateIndex
CREATE INDEX "PatientCriticalFlag_severity_status_idx" ON "PatientCriticalFlag"("severity", "status");

-- CreateIndex
CREATE INDEX "HomeTherapyRequest_patientId_idx" ON "HomeTherapyRequest"("patientId");

-- CreateIndex
CREATE INDEX "HomeTherapyRequest_requestingDoctorId_idx" ON "HomeTherapyRequest"("requestingDoctorId");

-- CreateIndex
CREATE INDEX "HomeTherapyRequest_branchId_status_idx" ON "HomeTherapyRequest"("branchId", "status");

-- CreateIndex
CREATE INDEX "HomeTherapyRequest_status_createdAt_idx" ON "HomeTherapyRequest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HomeTherapySession_therapistFeedbackId_key" ON "HomeTherapySession"("therapistFeedbackId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeTherapySession_patientFeedbackId_key" ON "HomeTherapySession"("patientFeedbackId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeTherapySession_appointmentId_key" ON "HomeTherapySession"("appointmentId");

-- CreateIndex
CREATE INDEX "HomeTherapySession_therapistId_scheduledDate_idx" ON "HomeTherapySession"("therapistId", "scheduledDate");

-- CreateIndex
CREATE INDEX "HomeTherapySession_patientId_scheduledDate_idx" ON "HomeTherapySession"("patientId", "scheduledDate");

-- CreateIndex
CREATE INDEX "HomeTherapySession_branchId_scheduledDate_idx" ON "HomeTherapySession"("branchId", "scheduledDate");

-- CreateIndex
CREATE INDEX "HomeTherapySession_status_scheduledDate_idx" ON "HomeTherapySession"("status", "scheduledDate");

-- CreateIndex
CREATE INDEX "HomeTherapySession_requestId_sessionNumber_idx" ON "HomeTherapySession"("requestId", "sessionNumber");

-- CreateIndex
CREATE INDEX "TherapistLocationPing_sessionId_timestamp_idx" ON "TherapistLocationPing"("sessionId", "timestamp");

-- CreateIndex
CREATE INDEX "TherapistLocationPing_therapistId_timestamp_idx" ON "TherapistLocationPing"("therapistId", "timestamp");

-- CreateIndex
CREATE INDEX "HomeTherapyFeedback_sessionId_idx" ON "HomeTherapyFeedback"("sessionId");

-- CreateIndex
CREATE INDEX "HomeTherapyFeedback_authorRole_createdAt_idx" ON "HomeTherapyFeedback"("authorRole", "createdAt");

-- CreateIndex
CREATE INDEX "VoiceConversation_patientId_createdAt_idx" ON "VoiceConversation"("patientId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "VoiceConversation_escalated_idx" ON "VoiceConversation"("escalated");

-- CreateIndex
CREATE INDEX "VoiceMessage_conversationId_createdAt_idx" ON "VoiceMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AyurvedicFood_branchId_isActive_idx" ON "AyurvedicFood"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "AyurvedicFood_category_idx" ON "AyurvedicFood"("category");

-- CreateIndex
CREATE INDEX "AyurvedicRecipe_branchId_isActive_idx" ON "AyurvedicRecipe"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "AyurvedicRecipe_mealCategory_idx" ON "AyurvedicRecipe"("mealCategory");

-- CreateIndex
CREATE INDEX "RecipeIngredient_recipeId_sortOrder_idx" ON "RecipeIngredient"("recipeId", "sortOrder");

-- CreateIndex
CREATE INDEX "DietMealFoodLink_mealId_isAvoid_sortOrder_idx" ON "DietMealFoodLink"("mealId", "isAvoid", "sortOrder");

-- CreateIndex
CREATE INDEX "HealthReport_patientId_createdAt_idx" ON "HealthReport"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "HealthReport_doctorId_idx" ON "HealthReport"("doctorId");

-- CreateIndex
CREATE INDEX "HealthReport_appointmentId_idx" ON "HealthReport"("appointmentId");

-- CreateIndex
CREATE INDEX "HealthReport_branchId_idx" ON "HealthReport"("branchId");

-- CreateIndex
CREATE INDEX "HealthReport_journeyPhaseId_idx" ON "HealthReport"("journeyPhaseId");

-- CreateIndex
CREATE INDEX "HealthReport_reportType_idx" ON "HealthReport"("reportType");

-- CreateIndex
CREATE INDEX "FollowUpTask_doctorId_status_dueDate_idx" ON "FollowUpTask"("doctorId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "FollowUpTask_doctorId_status_priority_idx" ON "FollowUpTask"("doctorId", "status", "priority");

-- CreateIndex
CREATE INDEX "FollowUpTask_patientId_idx" ON "FollowUpTask"("patientId");

-- CreateIndex
CREATE INDEX "FollowUpTask_triggerType_triggerRef_idx" ON "FollowUpTask"("triggerType", "triggerRef");

-- CreateIndex
CREATE INDEX "WorkflowRule_branchId_isActive_idx" ON "WorkflowRule"("branchId", "isActive");

-- CreateIndex
CREATE INDEX "WorkflowRule_triggerType_idx" ON "WorkflowRule"("triggerType");

-- CreateIndex
CREATE INDEX "WorkflowRuleLog_ruleId_triggeredAt_idx" ON "WorkflowRuleLog"("ruleId", "triggeredAt");

-- CreateIndex
CREATE INDEX "WorkflowRuleLog_patientId_idx" ON "WorkflowRuleLog"("patientId");

-- CreateIndex
CREATE INDEX "WorkflowCooldown_ruleId_idx" ON "WorkflowCooldown"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowCooldown_ruleId_patientId_key" ON "WorkflowCooldown"("ruleId", "patientId");

-- CreateIndex
CREATE INDEX "WaterIntakeLog_patientId_date_idx" ON "WaterIntakeLog"("patientId", "date");

-- CreateIndex
CREATE INDEX "WaterIntakeLog_patientId_loggedAt_idx" ON "WaterIntakeLog"("patientId", "loggedAt");

-- CreateIndex
CREATE INDEX "ActivityLog_patientId_date_idx" ON "ActivityLog"("patientId", "date");

-- CreateIndex
CREATE INDEX "ActivityLog_patientId_loggedAt_idx" ON "ActivityLog"("patientId", "loggedAt");

-- CreateIndex
CREATE INDEX "BodyMeasurementLog_patientId_loggedAt_idx" ON "BodyMeasurementLog"("patientId", "loggedAt");

-- CreateIndex
CREATE INDEX "MealPhotoLog_patientId_date_idx" ON "MealPhotoLog"("patientId", "date");

-- CreateIndex
CREATE INDEX "DailyMotivationCard_patientId_isSaved_idx" ON "DailyMotivationCard"("patientId", "isSaved");

-- CreateIndex
CREATE UNIQUE INDEX "DailyMotivationCard_patientId_date_key" ON "DailyMotivationCard"("patientId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "_AnnouncementTargetBranches_AB_unique" ON "_AnnouncementTargetBranches"("A", "B");

-- CreateIndex
CREATE INDEX "_AnnouncementTargetBranches_B_index" ON "_AnnouncementTargetBranches"("B");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSnapshot" ADD CONSTRAINT "UserSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueEntry" ADD CONSTRAINT "QueueEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Doctor" ADD CONSTRAINT "Doctor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientAssignment" ADD CONSTRAINT "PatientAssignment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientAssignment" ADD CONSTRAINT "PatientAssignment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientAssignment" ADD CONSTRAINT "PatientAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedSlot" ADD CONSTRAINT "BlockedSlot_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockedSlot" ADD CONSTRAINT "BlockedSlot_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Therapist" ADD CONSTRAINT "Therapist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pharmacist" ADD CONSTRAINT "Pharmacist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyCheckIn" ADD CONSTRAINT "DailyCheckIn_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoPrescription" ADD CONSTRAINT "VideoPrescription_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoPrescription" ADD CONSTRAINT "VideoPrescription_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoPrescription" ADD CONSTRAINT "VideoPrescription_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoPrescription" ADD CONSTRAINT "VideoPrescription_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "ExerciseVideo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoPrescription" ADD CONSTRAINT "VideoPrescription_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_triageSessionId_fkey" FOREIGN KEY ("triageSessionId") REFERENCES "TriageSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_groupSessionId_fkey" FOREIGN KEY ("groupSessionId") REFERENCES "GroupSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customReminderTemplateId_fkey" FOREIGN KEY ("customReminderTemplateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customReminderUpdatedById_fkey" FOREIGN KEY ("customReminderUpdatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "TreatmentJourney"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "TreatmentPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "TreatmentJourney"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_triageSessionId_fkey" FOREIGN KEY ("triageSessionId") REFERENCES "TriageSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Journey" ADD CONSTRAINT "Journey_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Journey" ADD CONSTRAINT "Journey_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Journey" ADD CONSTRAINT "Journey_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationLog" ADD CONSTRAINT "MedicationLog_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationLog" ADD CONSTRAINT "MedicationLog_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkOperation" ADD CONSTRAINT "BulkOperation_initiatedBy_fkey" FOREIGN KEY ("initiatedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicineStock" ADD CONSTRAINT "MedicineStock_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicineStock" ADD CONSTRAINT "MedicineStock_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyDispense" ADD CONSTRAINT "PharmacyDispense_dispensedBy_fkey" FOREIGN KEY ("dispensedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyDispense" ADD CONSTRAINT "PharmacyDispense_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyDispense" ADD CONSTRAINT "PharmacyDispense_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyDispense" ADD CONSTRAINT "PharmacyDispense_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PharmacyOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyDispense" ADD CONSTRAINT "PharmacyDispense_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyOrder" ADD CONSTRAINT "PharmacyOrder_orderedBy_fkey" FOREIGN KEY ("orderedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyOrder" ADD CONSTRAINT "PharmacyOrder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyOrder" ADD CONSTRAINT "PharmacyOrder_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyOrder" ADD CONSTRAINT "PharmacyOrder_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyOrderItem" ADD CONSTRAINT "PharmacyOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PharmacyOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyOrderItem" ADD CONSTRAINT "PharmacyOrderItem_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispenseItem" ADD CONSTRAINT "DispenseItem_dispenseId_fkey" FOREIGN KEY ("dispenseId") REFERENCES "PharmacyDispense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispenseItem" ADD CONSTRAINT "DispenseItem_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageSession" ADD CONSTRAINT "TriageSession_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageSession" ADD CONSTRAINT "TriageSession_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageOverride" ADD CONSTRAINT "TriageOverride_triageSessionId_fkey" FOREIGN KEY ("triageSessionId") REFERENCES "TriageSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriageOverride" ADD CONSTRAINT "TriageOverride_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_pharmacistId_fkey" FOREIGN KEY ("pharmacistId") REFERENCES "Pharmacist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffThread" ADD CONSTRAINT "StaffThread_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffThread" ADD CONSTRAINT "StaffThread_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffThread" ADD CONSTRAINT "StaffThread_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffThreadMember" ADD CONSTRAINT "StaffThreadMember_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "StaffThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffThreadMember" ADD CONSTRAINT "StaffThreadMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffThreadMember" ADD CONSTRAINT "StaffThreadMember_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMessage" ADD CONSTRAINT "StaffMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "StaffThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffMessage" ADD CONSTRAINT "StaffMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefillRequest" ADD CONSTRAINT "RefillRequest_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefillRequest" ADD CONSTRAINT "RefillRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefillRequest" ADD CONSTRAINT "RefillRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionChecklist" ADD CONSTRAINT "RetentionChecklist_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionChecklist" ADD CONSTRAINT "RetentionChecklist_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentFeedback" ADD CONSTRAINT "AppointmentFeedback_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentFeedback" ADD CONSTRAINT "AppointmentFeedback_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationFeedback" ADD CONSTRAINT "ConsultationFeedback_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationFeedback" ADD CONSTRAINT "ConsultationFeedback_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationFeedback" ADD CONSTRAINT "ConsultationFeedback_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationFeedback" ADD CONSTRAINT "ConsultationFeedback_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyFeedback" ADD CONSTRAINT "JourneyFeedback_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "TreatmentJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyFeedback" ADD CONSTRAINT "JourneyFeedback_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyFeedback" ADD CONSTRAINT "JourneyFeedback_leadDoctorId_fkey" FOREIGN KEY ("leadDoctorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyFeedback" ADD CONSTRAINT "JourneyFeedback_primaryClinicianId_fkey" FOREIGN KEY ("primaryClinicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyFeedback" ADD CONSTRAINT "JourneyFeedback_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThankYouCard" ADD CONSTRAINT "ThankYouCard_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "JourneyFeedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThankYouCard" ADD CONSTRAINT "ThankYouCard_recipientDoctorId_fkey" FOREIGN KEY ("recipientDoctorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentJourney" ADD CONSTRAINT "TreatmentJourney_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentJourney" ADD CONSTRAINT "TreatmentJourney_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentJourney" ADD CONSTRAINT "TreatmentJourney_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyPhase" ADD CONSTRAINT "JourneyPhase_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "TreatmentJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhaseTask" ADD CONSTRAINT "PhaseTask_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "JourneyPhase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCompletion" ADD CONSTRAINT "TaskCompletion_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "PhaseTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskCompletion" ADD CONSTRAINT "TaskCompletion_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JourneyMilestone" ADD CONSTRAINT "JourneyMilestone_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "TreatmentJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientVital" ADD CONSTRAINT "PatientVital_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "TreatmentJourney"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientVital" ADD CONSTRAINT "PatientVital_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescribedVital" ADD CONSTRAINT "PrescribedVital_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrescribedVital" ADD CONSTRAINT "PrescribedVital_prescribedById_fkey" FOREIGN KEY ("prescribedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadge" ADD CONSTRAINT "UserBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "Badge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchCompetition" ADD CONSTRAINT "BranchCompetition_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchCompetitionEntry" ADD CONSTRAINT "BranchCompetitionEntry_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "BranchCompetition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BranchCompetitionEntry" ADD CONSTRAINT "BranchCompetitionEntry_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientChallengeCompletion" ADD CONSTRAINT "PatientChallengeCompletion_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientChallengeCompletion" ADD CONSTRAINT "PatientChallengeCompletion_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "DailyChallenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZenPointsLedger" ADD CONSTRAINT "ZenPointsLedger_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientStreak" ADD CONSTRAINT "PatientStreak_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoshaForecast" ADD CONSTRAINT "DoshaForecast_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NudgeLog" ADD CONSTRAINT "NudgeLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceSharing" ADD CONSTRAINT "ResourceSharing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceSharing" ADD CONSTRAINT "ResourceSharing_fromBranchId_fkey" FOREIGN KEY ("fromBranchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceSharing" ADD CONSTRAINT "ResourceSharing_toBranchId_fkey" FOREIGN KEY ("toBranchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_medicineId_fkey" FOREIGN KEY ("medicineId") REFERENCES "Medicine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromBranchId_fkey" FOREIGN KEY ("fromBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toBranchId_fkey" FOREIGN KEY ("toBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffActivity" ADD CONSTRAINT "StaffActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffActivity" ADD CONSTRAINT "StaffActivity_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAttendance" ADD CONSTRAINT "StaffAttendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAttendance" ADD CONSTRAINT "StaffAttendance_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffSkill" ADD CONSTRAINT "StaffSkill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicianXP" ADD CONSTRAINT "ClinicianXP_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "XPLedger" ADD CONSTRAINT "XPLedger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonalChallengeProgress" ADD CONSTRAINT "SeasonalChallengeProgress_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "SeasonalChallenge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardRedemption" ADD CONSTRAINT "RewardRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardRedemption" ADD CONSTRAINT "RewardRedemption_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "RewardItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorSession" ADD CONSTRAINT "MentorSession_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorSession" ADD CONSTRAINT "MentorSession_menteeId_fkey" FOREIGN KEY ("menteeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientQuestProgress" ADD CONSTRAINT "PatientQuestProgress_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientQuestProgress" ADD CONSTRAINT "PatientQuestProgress_questId_fkey" FOREIGN KEY ("questId") REFERENCES "HealthQuest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthAvatar" ADD CONSTRAINT "HealthAvatar_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientFamily" ADD CONSTRAINT "PatientFamily_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientFamilyMember" ADD CONSTRAINT "PatientFamilyMember_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "PatientFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientFamilyMember" ADD CONSTRAINT "PatientFamilyMember_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentUnlock" ADD CONSTRAINT "ContentUnlock_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentUnlock" ADD CONSTRAINT "ContentUnlock_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "HealthContent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRead" ADD CONSTRAINT "AnnouncementRead_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRead" ADD CONSTRAINT "AnnouncementRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffNote" ADD CONSTRAINT "HandoffNote_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffNote" ADD CONSTRAINT "HandoffNote_fromClinicianId_fkey" FOREIGN KEY ("fromClinicianId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffNote" ADD CONSTRAINT "HandoffNote_toClinicianId_fkey" FOREIGN KEY ("toClinicianId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffNote" ADD CONSTRAINT "HandoffNote_toBranchId_fkey" FOREIGN KEY ("toBranchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffNote" ADD CONSTRAINT "HandoffNote_sourceAppointmentId_fkey" FOREIGN KEY ("sourceAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapistSessionNote" ADD CONSTRAINT "TherapistSessionNote_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapistSessionNote" ADD CONSTRAINT "TherapistSessionNote_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapistSessionNote" ADD CONSTRAINT "TherapistSessionNote_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapyOutcome" ADD CONSTRAINT "TherapyOutcome_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapyOutcome" ADD CONSTRAINT "TherapyOutcome_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapyOutcome" ADD CONSTRAINT "TherapyOutcome_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitSummary" ADD CONSTRAINT "VisitSummary_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisitSummary" ADD CONSTRAINT "VisitSummary_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalFeatureFlag" ADD CONSTRAINT "HospitalFeatureFlag_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalFeatureFlag" ADD CONSTRAINT "HospitalFeatureFlag_featureKey_fkey" FOREIGN KEY ("featureKey") REFERENCES "FeatureRegistry"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalFeatureFlag" ADD CONSTRAINT "HospitalFeatureFlag_enabledById_fkey" FOREIGN KEY ("enabledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuperAdminAuditLog" ADD CONSTRAINT "SuperAdminAuditLog_superAdminId_fkey" FOREIGN KEY ("superAdminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuperAdminAuditLog" ADD CONSTRAINT "SuperAdminAuditLog_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapyRoom" ADD CONSTRAINT "TherapyRoom_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapyRoomBooking" ADD CONSTRAINT "TherapyRoomBooking_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "TherapyRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapyRoomBooking" ADD CONSTRAINT "TherapyRoomBooking_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietPrescription" ADD CONSTRAINT "DietPrescription_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietPrescription" ADD CONSTRAINT "DietPrescription_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietPrescription" ADD CONSTRAINT "DietPrescription_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "DietPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietPackage" ADD CONSTRAINT "DietPackage_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietPackage" ADD CONSTRAINT "DietPackage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietPackage" ADD CONSTRAINT "DietPackage_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietPackageMeal" ADD CONSTRAINT "DietPackageMeal_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "DietPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietMeal" ADD CONSTRAINT "DietMeal_dietPrescriptionId_fkey" FOREIGN KEY ("dietPrescriptionId") REFERENCES "DietPrescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietAdherenceLog" ADD CONSTRAINT "DietAdherenceLog_dietPrescriptionId_fkey" FOREIGN KEY ("dietPrescriptionId") REFERENCES "DietPrescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietAdherenceLog" ADD CONSTRAINT "DietAdherenceLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalPhoto" ADD CONSTRAINT "ClinicalPhoto_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalPhoto" ADD CONSTRAINT "ClinicalPhoto_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "TreatmentJourney"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalPhoto" ADD CONSTRAINT "ClinicalPhoto_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "JourneyPhase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapistSkill" ADD CONSTRAINT "TherapistSkill_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TreatmentPackage" ADD CONSTRAINT "TreatmentPackage_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageEnrolment" ADD CONSTRAINT "PackageEnrolment_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "TreatmentPackage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageEnrolment" ADD CONSTRAINT "PackageEnrolment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageEnrolment" ADD CONSTRAINT "PackageEnrolment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageSessionLog" ADD CONSTRAINT "PackageSessionLog_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "PackageEnrolment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageSessionLog" ADD CONSTRAINT "PackageSessionLog_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageSessionLog" ADD CONSTRAINT "PackageSessionLog_conductedById_fkey" FOREIGN KEY ("conductedById") REFERENCES "Therapist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "TherapyRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupSession" ADD CONSTRAINT "GroupSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Todo" ADD CONSTRAINT "Todo_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Todo" ADD CONSTRAINT "Todo_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Todo" ADD CONSTRAINT "Todo_relatedPatientId_fkey" FOREIGN KEY ("relatedPatientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Todo" ADD CONSTRAINT "Todo_relatedAppointmentId_fkey" FOREIGN KEY ("relatedAppointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Todo" ADD CONSTRAINT "Todo_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfExamSubmission" ADD CONSTRAINT "SelfExamSubmission_triageSessionId_fkey" FOREIGN KEY ("triageSessionId") REFERENCES "TriageSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfExamSubmission" ADD CONSTRAINT "SelfExamSubmission_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfExamSubmission" ADD CONSTRAINT "SelfExamSubmission_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfExamSubmission" ADD CONSTRAINT "SelfExamSubmission_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfExamSubmission" ADD CONSTRAINT "SelfExamSubmission_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfExamSubmission" ADD CONSTRAINT "SelfExamSubmission_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SymptomHistoryEntry" ADD CONSTRAINT "SymptomHistoryEntry_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TongueObservation" ADD CONSTRAINT "TongueObservation_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TongueObservation" ADD CONSTRAINT "TongueObservation_checkInId_fkey" FOREIGN KEY ("checkInId") REFERENCES "DailyCheckIn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TongueObservation" ADD CONSTRAINT "TongueObservation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoolLog" ADD CONSTRAINT "StoolLog_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoolLog" ADD CONSTRAINT "StoolLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UrineLog" ADD CONSTRAINT "UrineLog_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UrineLog" ADD CONSTRAINT "UrineLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoMMeasurement" ADD CONSTRAINT "RoMMeasurement_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhysicalObservation" ADD CONSTRAINT "PhysicalObservation_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceObservation" ADD CONSTRAINT "VoiceObservation_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestiveProfile" ADD CONSTRAINT "DigestiveProfile_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LifestyleContext" ADD CONSTRAINT "LifestyleContext_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "SelfExamSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConstitutionProfile" ADD CONSTRAINT "ConstitutionProfile_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfExamProtocolOverride" ADD CONSTRAINT "SelfExamProtocolOverride_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfExamProtocolOverride" ADD CONSTRAINT "SelfExamProtocolOverride_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderSetting" ADD CONSTRAINT "ReminderSetting_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderSetting" ADD CONSTRAINT "ReminderSetting_dailyReminderTemplateId_fkey" FOREIGN KEY ("dailyReminderTemplateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderDeliveryLog" ADD CONSTRAINT "ReminderDeliveryLog_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderDeliveryLog" ADD CONSTRAINT "ReminderDeliveryLog_patientUserId_fkey" FOREIGN KEY ("patientUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderDeliveryLog" ADD CONSTRAINT "ReminderDeliveryLog_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderDeliveryLog" ADD CONSTRAINT "ReminderDeliveryLog_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentFollowUp" ADD CONSTRAINT "AppointmentFollowUp_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentFollowUp" ADD CONSTRAINT "AppointmentFollowUp_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentFollowUp" ADD CONSTRAINT "AppointmentFollowUp_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCriticalFlag" ADD CONSTRAINT "PatientCriticalFlag_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCriticalFlag" ADD CONSTRAINT "PatientCriticalFlag_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientCriticalFlag" ADD CONSTRAINT "PatientCriticalFlag_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeTherapyRequest" ADD CONSTRAINT "HomeTherapyRequest_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeTherapyRequest" ADD CONSTRAINT "HomeTherapyRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeTherapyRequest" ADD CONSTRAINT "HomeTherapyRequest_requestingDoctorId_fkey" FOREIGN KEY ("requestingDoctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeTherapyRequest" ADD CONSTRAINT "HomeTherapyRequest_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeTherapySession" ADD CONSTRAINT "HomeTherapySession_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "HomeTherapyRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeTherapySession" ADD CONSTRAINT "HomeTherapySession_therapistId_fkey" FOREIGN KEY ("therapistId") REFERENCES "Therapist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeTherapySession" ADD CONSTRAINT "HomeTherapySession_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeTherapySession" ADD CONSTRAINT "HomeTherapySession_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeTherapySession" ADD CONSTRAINT "HomeTherapySession_therapistFeedbackId_fkey" FOREIGN KEY ("therapistFeedbackId") REFERENCES "HomeTherapyFeedback"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeTherapySession" ADD CONSTRAINT "HomeTherapySession_patientFeedbackId_fkey" FOREIGN KEY ("patientFeedbackId") REFERENCES "HomeTherapyFeedback"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TherapistLocationPing" ADD CONSTRAINT "TherapistLocationPing_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "HomeTherapySession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceConversation" ADD CONSTRAINT "VoiceConversation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceMessage" ADD CONSTRAINT "VoiceMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "VoiceConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AyurvedicFood" ADD CONSTRAINT "AyurvedicFood_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AyurvedicFood" ADD CONSTRAINT "AyurvedicFood_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AyurvedicRecipe" ADD CONSTRAINT "AyurvedicRecipe_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AyurvedicRecipe" ADD CONSTRAINT "AyurvedicRecipe_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "AyurvedicRecipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_foodId_fkey" FOREIGN KEY ("foodId") REFERENCES "AyurvedicFood"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietMealFoodLink" ADD CONSTRAINT "DietMealFoodLink_mealId_fkey" FOREIGN KEY ("mealId") REFERENCES "DietMeal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DietMealFoodLink" ADD CONSTRAINT "DietMealFoodLink_foodId_fkey" FOREIGN KEY ("foodId") REFERENCES "AyurvedicFood"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthReport" ADD CONSTRAINT "HealthReport_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthReport" ADD CONSTRAINT "HealthReport_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthReport" ADD CONSTRAINT "HealthReport_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthReport" ADD CONSTRAINT "HealthReport_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthReport" ADD CONSTRAINT "HealthReport_journeyPhaseId_fkey" FOREIGN KEY ("journeyPhaseId") REFERENCES "JourneyPhase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "Doctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRule" ADD CONSTRAINT "WorkflowRule_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRuleLog" ADD CONSTRAINT "WorkflowRuleLog_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "WorkflowRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRuleLog" ADD CONSTRAINT "WorkflowRuleLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowCooldown" ADD CONSTRAINT "WorkflowCooldown_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "WorkflowRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowCooldown" ADD CONSTRAINT "WorkflowCooldown_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaterIntakeLog" ADD CONSTRAINT "WaterIntakeLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BodyMeasurementLog" ADD CONSTRAINT "BodyMeasurementLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealPhotoLog" ADD CONSTRAINT "MealPhotoLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyMotivationCard" ADD CONSTRAINT "DailyMotivationCard_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AnnouncementTargetBranches" ADD CONSTRAINT "_AnnouncementTargetBranches_A_fkey" FOREIGN KEY ("A") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AnnouncementTargetBranches" ADD CONSTRAINT "_AnnouncementTargetBranches_B_fkey" FOREIGN KEY ("B") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;


