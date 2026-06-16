-- CreateTable
CREATE TABLE "HospitalWhatsappConfig" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "instanceName" TEXT NOT NULL,
    "apiUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalWhatsappConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HospitalWhatsappConfig_hospitalId_key" ON "HospitalWhatsappConfig"("hospitalId");

-- AddForeignKey
ALTER TABLE "HospitalWhatsappConfig" ADD CONSTRAINT "HospitalWhatsappConfig_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

