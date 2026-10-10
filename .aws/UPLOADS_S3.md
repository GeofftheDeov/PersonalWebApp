# S3 uploads (campaign banners, #81)

The backend reaches S3 only through `integrations().uploads` (`backend/utils/integrations.ts`).
It needs a private bucket per environment, a CORS rule so the browser can `PUT` to it, and
permission for the ECS task role. Until `UPLOADS_BUCKET` is set, uploads are off: the
banner endpoints answer 503 "not set up" and every campaign shows its fallback banner.

Nothing here has been created yet. The names below are suggestions; bucket names are
global, so add a suffix if one is taken. Region: `us-east-2` (where the ECS services run).

## 1. Buckets (private)

```sh
for B in pwa-uploads-dev pwa-uploads-prod; do
  aws s3api create-bucket --bucket "$B" --region us-east-2 \
    --create-bucket-configuration LocationConstraint=us-east-2
  aws s3api put-public-access-block --bucket "$B" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-ownership-controls --bucket "$B" \
    --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
done
```

New buckets encrypt with SSE-S3 by default; nothing more is needed for that.

## 2. CORS (the browser uploads straight to S3)

`cors-dev.json`:

```json
{ "CORSRules": [{
  "AllowedOrigins": ["https://deov.geoffthedeov.net", "http://localhost:3000", "http://127.0.0.1:3000"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["content-type"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000
}] }
```

`cors-prod.json`: the same with `"AllowedOrigins": ["https://geoffthedeov.net", "https://www.geoffthedeov.net"]`.

```sh
aws s3api put-bucket-cors --bucket pwa-uploads-dev  --cors-configuration file://cors-dev.json
aws s3api put-bucket-cors --bucket pwa-uploads-prod --cors-configuration file://cors-prod.json
```

## 3. IAM: let the task role use the buckets

Both `.aws/backend-task-definition.json` (prod) and `.aws/dev-task-definition.json` use the
task role `ecsTaskRole`, so one inline policy covers both. (Sharing the role also means dev
can write to the prod bucket; separate task roles per environment would fix that.)

```sh
aws iam put-role-policy --role-name ecsTaskRole --policy-name pwa-uploads --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
    "Resource": [
      "arn:aws:s3:::pwa-uploads-dev/campaign-banners/*",
      "arn:aws:s3:::pwa-uploads-prod/campaign-banners/*"
    ]
  }]
}'
```

Add the matching prefix to `Resource` when Letters attachments or profile pictures start using it.

The app signs URLs with the task role's temporary credentials, so a presigned URL stops
working when those credentials rotate, even if its own expiry is later. Uploads get 5 minutes
and reads 1 hour, so this rarely matters; CloudFront (step 4) avoids it for reads.

## 4. CloudFront (optional)

Without it, banners are read through one-hour presigned GET URLs, which works but changes the
URL on each page load, so browsers re-download banners. With it:

1. Create a distribution whose origin is the bucket's REST endpoint
   (`pwa-uploads-prod.s3.us-east-2.amazonaws.com`) with **Origin Access Control** (sign requests),
   viewer protocol "Redirect HTTP to HTTPS", and the CachingOptimized policy.
2. Add the bucket policy CloudFront offers to copy: it allows `s3:GetObject` to
   `cloudfront.amazonaws.com` on the condition `AWS:SourceArn` = the distribution's ARN. The bucket
   stays non-public; only that distribution can read it.
3. Set `UPLOADS_CDN_URL` to `https://<distribution>.cloudfront.net`.

Banner keys contain a random UUID and never change, so they cache forever. Anyone holding a
CloudFront URL can view that banner, but the URL is only handed to people who can see the campaign.

## 5. Environment variables

Both task definitions already list these as empty, so uploads stay off until you fill them in:

| Variable | dev | prod |
|---|---|---|
| `UPLOADS_BUCKET` | `pwa-uploads-dev` | `pwa-uploads-prod` |
| `UPLOADS_REGION` | `us-east-2` | `us-east-2` |
| `UPLOADS_CDN_URL` | empty, or the dev distribution | empty, or the prod distribution |

None of them are secrets. Credentials come from the task role, never from env vars.

## 6. Check it

As a campaign owner on dev, click **Add banner** on the campaign page, pick an
image, save. The banner should show on the campaign page, the Game Night cards and the
dashboard. In the bucket: `campaign-banners/<campaignId>/<uuid>.webp`. Replacing the banner
deletes the old object; removing it deletes the current one.

A browser console error mentioning CORS on the `PUT` means step 2 is missing or the origin
isn't listed. A 403 `SignatureDoesNotMatch` usually means the request's Content-Type or size
differed from what was signed, which the app never does on its own.

Uploads whose URL was requested but never saved as a banner stay in the bucket. They are
rare and small; a cleanup job can come later.
