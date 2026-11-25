"use client";

import ImageCropDialog from '@/components/ImageCropDialog';
import { BANNER_ASPECT, type Banner, cropToBanner, uploadBanner } from '@/lib/banner';

/**
 * The owner's banner cropper (#81): pick an image, drag and zoom it inside a
 * 4:1 frame, then upload the crop. The server checks that the caller owns the
 * campaign; this only opens for owners and admins.
 */
export default function BannerEditor({ campaignId, onClose, onSaved }: {
  campaignId: string;
  onClose: () => void;
  onSaved: (banner: Banner) => void;
}) {
  return (
    <ImageCropDialog
      title="The campaign's banner"
      aspect={BANNER_ASPECT}
      label="Banner crop"
      hint="It shows at 4:1 behind the campaign’s card, and across the top of its page. Drag to choose what shows. JPEG, PNG or WebP; it’s resized before it’s uploaded."
      saveLabel="Save the banner"
      failure="The banner couldn’t be uploaded."
      save={async (img, crop) => uploadBanner(campaignId, await cropToBanner(img, crop))}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}
