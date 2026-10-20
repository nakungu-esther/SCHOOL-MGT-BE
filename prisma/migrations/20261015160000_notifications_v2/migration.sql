-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('ACADEMIC', 'ATTENDANCE', 'FINANCE', 'ANNOUNCEMENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SYSTEM', 'STUDENT_ADMITTED', 'STUDENT_CLASS_CHANGED', 'STUDENT_TRANSFERRED', 'ENROLLMENT_UPDATED', 'ATTENDANCE_ABSENT', 'ATTENDANCE_LATE', 'ATTENDANCE_ADMIN_ALERT', 'EXAM_PUBLISHED', 'REPORT_CARD_AVAILABLE', 'INVOICE_ISSUED', 'PAYMENT_RECORDED', 'FEE_DUE', 'ANNOUNCEMENT', 'TEACHING_ASSIGNED', 'MANUAL');

-- AlterTable
ALTER TABLE "portal_notifications" ADD COLUMN "category" "NotificationCategory" NOT NULL DEFAULT 'SYSTEM',
ADD COLUMN "type" "NotificationType" NOT NULL DEFAULT 'SYSTEM',
ADD COLUMN "related_entity_type" TEXT,
ADD COLUMN "related_entity_id" UUID,
ADD COLUMN "link_path" TEXT,
ADD COLUMN "idempotency_key" TEXT,
ADD COLUMN "archived_at" TIMESTAMP(3),
ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "portal_notifications_school_id_user_id_category_idx" ON "portal_notifications"("school_id", "user_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "portal_notifications_school_id_user_id_idempotency_key_key" ON "portal_notifications"("school_id", "user_id", "idempotency_key");

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "academic_enabled" BOOLEAN NOT NULL DEFAULT true,
    "attendance_enabled" BOOLEAN NOT NULL DEFAULT true,
    "finance_enabled" BOOLEAN NOT NULL DEFAULT true,
    "announcement_enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_school_id_user_id_key" ON "notification_preferences"("school_id", "user_id");

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
