/**
 * Zod schemas for the /api/voice-coach REST routes. Used by the existing
 * `validate()` middleware to fail-fast on bad payloads before they reach the
 * service layer.
 */

import { z } from 'zod';

// POST /api/voice-coach/sessions
export const startSessionSchema = z.object({
    language: z.enum(['ta', 'en']).optional(),
});

// POST /api/voice-coach/sessions/:id/messages   (Phase B text-mode entry point)
export const sendMessageSchema = z.object({
    transcript: z.string().min(1).max(4000),
});

// POST /api/voice-coach/sessions/:id/notify-patient   (doctor WhatsApp note)
export const sendDoctorNoteSchema = z.object({
    note: z.string().min(1).max(1000),
});

// PATCH /api/voice-coach/preferences
export const updatePreferencesSchema = z
    .object({
        voiceCoachEnabled: z.boolean().optional(),
        preferredCoachLang: z.enum(['ta', 'en']).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, {
        message: 'At least one preference field is required',
    });

// GET /api/voice-coach/sessions  (pagination)
export const listSessionsQuerySchema = z.object({
    take: z.coerce.number().int().positive().max(50).default(20),
    cursor: z.string().optional(),
});
