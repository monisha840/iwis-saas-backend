import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import logger from '../lib/logger.js';

// Supabase client (initialized lazily)
let supabase = null;
function getSupabase() {
    if (!supabase && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    }
    return supabase;
}

// Memory storage for Supabase upload
const memoryStorage = multer.memoryStorage();

// Disk storage fallback (when Supabase not configured)
const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

/**
 * Upload a file to Supabase Storage, falling back to local disk.
 */
export async function uploadToSupabase(file, bucket = 'medical-documents') {
    const sb = getSupabase();

    if (!sb) {
        // Fallback to local path (already saved by multer disk storage)
        logger.warn('[Upload] Supabase not configured — using local storage');
        return `/uploads/${file.filename || file.originalname}`;
    }

    const path = `${Date.now()}-${file.originalname}`;
    const { data, error } = await sb.storage
        .from(bucket)
        .upload(path, file.buffer, {
            contentType: file.mimetype,
            upsert: false,
        });

    if (error) {
        logger.error('[Upload] Supabase upload failed', error);
        throw error;
    }

    const { data: urlData } = sb.storage.from(bucket).getPublicUrl(path);
    return urlData.publicUrl;
}

/**
 * Get the correct multer instance based on configuration.
 */
export function getUploadMiddleware(options = {}) {
    const { maxSizeMb = 10, fieldName = 'file' } = options;
    const useSupabase = !!getSupabase();

    const upload = multer({
        storage: useSupabase ? memoryStorage : diskStorage,
        limits: { fileSize: maxSizeMb * 1024 * 1024 },
    });

    return upload.single(fieldName);
}

// Pre-configured upload middleware
export const uploadSingle = getUploadMiddleware();

// Bucket names for different use cases
export const BUCKETS = {
    MEDICAL_DOCUMENTS: 'medical-documents',
    PROFILE_PICTURES: 'profile-pictures',
    PRESCRIPTIONS: 'prescriptions',
    JOURNEY_MEDIA: 'journey-media',
};
