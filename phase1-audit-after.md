═══════════════════════════════════════════════════════════════
 P0 ISOLATION AUDIT (read-only)
═══════════════════════════════════════════════════════════════
Total models: 154
  with hospitalId: 40
  with branchId:   35
  with neither:    83

── Phase 1 risk list (models with NO hospitalId AND NO branchId) ──
  • RefreshToken
  • PasswordResetToken
  • DailyCheckIn
  • ExerciseVideo
  • Document
  • MedicationLog
  • Medicine
  • PharmacyOrderItem
  • DispenseItem
  • InvoiceItem
  • TriageOverride
  • SpecialtyRoute
  • LeaderboardConfig
  • FeatureFlag
  • RefillRequest
  • ThankYouCard
  • JourneyPhase
  • PhaseTask
  • TaskCompletion
  • JourneyMilestone
  • PatientVital
  • PrescribedVital
  • Badge
  • UserBadge
  • BranchCompetition
  • DailyChallenge
  • PatientChallengeCompletion
  • ZenPointsLedger
  • PatientStreak
  • DoshaForecast
  • NudgeLog
  • ResourceSharing
  • StockTransfer
  • StaffSkill
  • ClinicianXP
  • XPLedger
  • SeasonalChallenge
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
  • AnnouncementRead
  • HandoffNote
  • TherapistSessionNote
  • TherapyOutcome
  • VisitSummary
  • Hospital
  • FeatureRegistry
  • TherapyRoomBooking
  • DietPackageMeal
  • DietMeal
  • DietAdherenceLog
  • TherapistSkill
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
  Phase 1 risk models: 83

RESULT: OK — 0 homeless rows.
