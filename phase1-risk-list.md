═══════════════════════════════════════════════════════════════
 P0 ISOLATION AUDIT (read-only)
═══════════════════════════════════════════════════════════════
Total models: 154
  with hospitalId: 12
  with branchId:   35
  with neither:    111

── Phase 1 risk list (models with NO hospitalId AND NO branchId) ──
  • RefreshToken
  • PasswordResetToken
  • AuditLog
  • Doctor
  • PatientAssignment
  • BlockedSlot
  • Therapist
  • Pharmacist
  • DailyCheckIn
  • ExerciseVideo
  • Availability
  • Notification
  • NotificationDelivery
  • NotificationPreference
  • Document
  • Journey
  • MedicationLog
  • BulkOperation
  • Medicine
  • PharmacyOrderItem
  • DispenseItem
  • InvoiceItem
  • TriageOverride
  • SpecialtyRoute
  • Message
  • StaffThreadMember
  • StaffMessage
  • LeaderboardConfig
  • FeatureFlag
  • RefillRequest
  • Referral
  • LeaderboardAudit
  • ThankYouCard
  • JourneyPhase
  • PhaseTask
  • TaskCompletion
  • JourneyMilestone
  • PatientVital
  • PrescribedVital
  • Badge
  • UserBadge
  • ClinicianStreak
  • BranchCompetition
  • DailyChallenge
  • PatientChallengeCompletion
  • ZenPointsLedger
  • PatientStreak
  • DoshaForecast
  • NudgeLog
  • GamificationAnomaly
  • AdaptiveTarget
  • ResourceSharing
  • StockTransfer
  • PerformanceScorecard
  • StaffSkill
  • ClinicianXP
  • XPLedger
  • SeasonalChallenge
  • SeasonalChallengeProgress
  • RewardItem
  • RewardRedemption
  • MentorSession
  • HealthQuest
  • PatientQuestProgress
  • HealthAvatar
  • PatientFamily
  • PatientFamilyMember
  • HealthContent
  • ContentUnlock
  • Announcement
  • AnnouncementRead
  • HandoffNote
  • TherapistSessionNote
  • TherapyOutcome
  • VisitSummary
  • Hospital
  • FeatureRegistry
  • TherapyRoomBooking
  • DietPrescription
  • DietPackageMeal
  • DietMeal
  • DietAdherenceLog
  • ClinicalPhoto
  • TherapistSkill
  • PackageEnrolment
  • PackageSessionLog
  • SymptomHistoryEntry
  • TongueObservation
  • StoolLog
  • UrineLog
  • RoMMeasurement
  • PhysicalObservation
  • VoiceObservation
  • DigestiveProfile
  • LifestyleContext
  • ConstitutionProfile
  • AppointmentFollowUp
  • TherapistLocationPing
  • HomeTherapyFeedback
  • VoiceConversation
  • VoiceMessage
  • RecipeIngredient
  • DietMealFoodLink
  • FollowUpTask
  • WorkflowRuleLog
  • WorkflowCooldown
  • WaterIntakeLog
  • ActivityLog
  • BodyMeasurementLog
  • MealPhotoLog
  • DailyMotivationCard

── Homeless-row check (rows where hospitalId IS NULL) ──
  ✓ none — every nullable-hospitalId model has 0 rows with a null hospital
  (6 model(s) have a NOT NULL hospitalId — homeless impossible by constraint)

═══════════════════════════════════════════════════════════════
 TOTALS
═══════════════════════════════════════════════════════════════
  Hospitals:           1
  Homeless rows total: 0
  Phase 1 risk models: 111

RESULT: OK — 0 homeless rows.
