-- Drop SMS + EMAIL delivery channels application-wide.
--
-- Order matters:
--  1. Strip SMS / EMAIL values from any column that uses the DeliveryChannel
--     enum (rows would otherwise block the enum drop).
--  2. Delete preference columns from NotificationPreference.
--  3. Drop column defaults that reference the old enum (Postgres cannot
--     cast a DEFAULT value across a type swap).
--  4. Recreate the enum without SMS / EMAIL members.
--  5. Re-apply the defaults using the new enum.

-- 1a. MessageTemplate.channels (DeliveryChannel[])
UPDATE "MessageTemplate"
   SET "channels" = ARRAY(
         SELECT c FROM unnest("channels") AS c
          WHERE c <> 'SMS' AND c <> 'EMAIL'
       )::"DeliveryChannel"[]
 WHERE 'SMS' = ANY("channels") OR 'EMAIL' = ANY("channels");

-- 1b. ReminderSetting.dailyReminderChannels (DeliveryChannel[])
UPDATE "ReminderSetting"
   SET "dailyReminderChannels" = ARRAY(
         SELECT c FROM unnest("dailyReminderChannels") AS c
          WHERE c <> 'SMS' AND c <> 'EMAIL'
       )::"DeliveryChannel"[]
 WHERE 'SMS' = ANY("dailyReminderChannels") OR 'EMAIL' = ANY("dailyReminderChannels");

-- Empty array would silently disable reminders. Reset to the new default so
-- the daily-checkin sweep keeps firing.
UPDATE "ReminderSetting"
   SET "dailyReminderChannels" = ARRAY['WHATSAPP', 'IN_APP']::"DeliveryChannel"[]
 WHERE array_length("dailyReminderChannels", 1) IS NULL;

-- 1c. Appointment.customReminderChannels (DeliveryChannel[])
UPDATE "Appointment"
   SET "customReminderChannels" = ARRAY(
         SELECT c FROM unnest("customReminderChannels") AS c
          WHERE c <> 'SMS' AND c <> 'EMAIL'
       )::"DeliveryChannel"[]
 WHERE 'SMS' = ANY("customReminderChannels") OR 'EMAIL' = ANY("customReminderChannels");

-- 1d. ReminderDeliveryLog.channel (single DeliveryChannel value).
-- Historical SMS / EMAIL log rows are an audit trail — keep them, but flip to
-- IN_APP so the column can keep its enum type after the drop. errorMessage
-- preserves the original channel.
UPDATE "ReminderDeliveryLog"
   SET "channel" = 'IN_APP',
       "errorMessage" = COALESCE("errorMessage", '') ||
                        CASE WHEN "errorMessage" IS NULL OR "errorMessage" = ''
                             THEN '[archived from SMS]'
                             ELSE ' [archived from SMS]' END
 WHERE "channel" = 'SMS';

UPDATE "ReminderDeliveryLog"
   SET "channel" = 'IN_APP',
       "errorMessage" = COALESCE("errorMessage", '') ||
                        CASE WHEN "errorMessage" IS NULL OR "errorMessage" = ''
                             THEN '[archived from EMAIL]'
                             ELSE ' [archived from EMAIL]' END
 WHERE "channel" = 'EMAIL';

-- 2. Drop the preference columns.
ALTER TABLE "NotificationPreference" DROP COLUMN IF EXISTS "emailEnabled";
ALTER TABLE "NotificationPreference" DROP COLUMN IF EXISTS "smsEnabled";

-- 3. Drop column defaults that reference the old enum.
ALTER TABLE "MessageTemplate"   ALTER COLUMN "channels"               DROP DEFAULT;
ALTER TABLE "ReminderSetting"   ALTER COLUMN "dailyReminderChannels"  DROP DEFAULT;
ALTER TABLE "Appointment"       ALTER COLUMN "customReminderChannels" DROP DEFAULT;

-- 4. Recreate the DeliveryChannel enum without SMS / EMAIL.
ALTER TYPE "DeliveryChannel" RENAME TO "DeliveryChannel_old";

CREATE TYPE "DeliveryChannel" AS ENUM ('WHATSAPP', 'IN_APP');

ALTER TABLE "MessageTemplate"
  ALTER COLUMN "channels" TYPE "DeliveryChannel"[]
  USING ("channels"::text::"DeliveryChannel"[]);

ALTER TABLE "ReminderSetting"
  ALTER COLUMN "dailyReminderChannels" TYPE "DeliveryChannel"[]
  USING ("dailyReminderChannels"::text::"DeliveryChannel"[]);

ALTER TABLE "Appointment"
  ALTER COLUMN "customReminderChannels" TYPE "DeliveryChannel"[]
  USING ("customReminderChannels"::text::"DeliveryChannel"[]);

ALTER TABLE "ReminderDeliveryLog"
  ALTER COLUMN "channel" TYPE "DeliveryChannel"
  USING ("channel"::text::"DeliveryChannel");

DROP TYPE "DeliveryChannel_old";

-- 5. Re-apply the defaults using the new enum.
ALTER TABLE "MessageTemplate"
  ALTER COLUMN "channels" SET DEFAULT ARRAY['WHATSAPP']::"DeliveryChannel"[];

ALTER TABLE "ReminderSetting"
  ALTER COLUMN "dailyReminderChannels" SET DEFAULT ARRAY['WHATSAPP', 'IN_APP']::"DeliveryChannel"[];

ALTER TABLE "Appointment"
  ALTER COLUMN "customReminderChannels" SET DEFAULT ARRAY[]::"DeliveryChannel"[];
