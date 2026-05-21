// utils/cloudinary.ts
import { v2 as cloudinary } from 'cloudinary';
import { logger } from './logger';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export async function uploadToCloudinary(
  buffer: Buffer,
  mimeType: string,
  folder: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const resourceType = mimeType.includes('pdf') ? 'raw' : 'image';

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType,
        allowed_formats: ['jpg', 'jpeg', 'png', 'pdf', 'tiff', 'webp', 'heic'],
        max_bytes: 50 * 1024 * 1024,
      },
      (error, result) => {
        if (error) {
          logger.error('Cloudinary upload error:', error);
          reject(new Error('File upload failed. Please try again.'));
        } else {
          resolve(result!.secure_url);
        }
      }
    );

    uploadStream.end(buffer);
  });
}

export async function deleteFromCloudinary(publicId: string): Promise<void> {
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    logger.warn(`Failed to delete from Cloudinary: ${publicId}`, err);
  }
}
