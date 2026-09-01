// S3-backed Storage: any S3-compatible service (MinIO in docker-compose,
// real S3/R2/Ceph in production), replacing apps/api/src/infrastructure/
// storage.ts's Bun S3Client. Unlike Bun's client this SDK needs no shim for
// the ReadableStream footgun CLAUDE.md warns about — Put takes an io.Reader,
// so there is no string-vs-stream ambiguity to get wrong.
package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// S3Config is the configuration NewS3 needs. Endpoint is empty for real AWS
// S3 (the SDK resolves the regional endpoint itself); set it for any other
// S3-compatible service, which also switches the client to path-style
// addressing (MinIO/R2/Ceph do not support the virtual-hosted
// bucket.endpoint form AWS uses).
type S3Config struct {
	Bucket          string
	Endpoint        string
	AccessKeyID     string
	SecretAccessKey string
	Region          string
}

type s3Storage struct {
	client *s3.Client
	bucket string
}

// NewS3 builds an S3-backed Storage from static credentials — no
// environment-variable or shared-config credential chain, so behaviour does
// not depend on what else happens to be on the host running the container.
func NewS3(cfg S3Config) Storage {
	client := s3.New(s3.Options{
		Region:      cfg.Region,
		Credentials: credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
		BaseEndpoint: func() *string {
			if cfg.Endpoint == "" {
				return nil
			}
			return aws.String(cfg.Endpoint)
		}(),
		UsePathStyle: cfg.Endpoint != "",
	})
	return &s3Storage{client: client, bucket: cfg.Bucket}
}

func (s *s3Storage) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	input := &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
		Body:   body,
	}
	if contentType != "" {
		input.ContentType = aws.String(contentType)
	}
	if size >= 0 {
		input.ContentLength = aws.Int64(size)
	}
	if _, err := s.client.PutObject(ctx, input); err != nil {
		return fmt.Errorf("storage: put %q: %w", key, err)
	}
	return nil
}

// GetStream reports (rc, found=false, err=nil) when the key does not exist,
// matching the interface contract so a download route can return a plain
// 404 rather than treating a miss as an infrastructure failure. exists()
// first (the way apps/api's Bun client used to check) is not needed here:
// GetObject reports a missing key as an error synchronously, before any
// bytes are streamed to the caller, so there is no risk of a 200 already
// having gone out with a truncated body.
func (s *s3Storage) GetStream(ctx context.Context, key string) (io.ReadCloser, bool, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		if isNotFound(err) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("storage: get %q: %w", key, err)
	}
	return out.Body, true, nil
}

// isNotFound recognises a missing-key response two ways: the typed
// NoSuchKey error real S3 returns for GetObject, and a bare HTTP 404 —
// MinIO and some other S3-compatible services answer a missing key with a
// generic error that does not deserialize to NoSuchKey.
func isNotFound(err error) bool {
	var noSuchKey *types.NoSuchKey
	if errors.As(err, &noSuchKey) {
		return true
	}
	var respErr *smithyhttp.ResponseError
	if errors.As(err, &respErr) && respErr.HTTPStatusCode() == 404 {
		return true
	}
	return false
}

func (s *s3Storage) Delete(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	objects := make([]types.ObjectIdentifier, len(keys))
	for i, key := range keys {
		objects[i] = types.ObjectIdentifier{Key: aws.String(key)}
	}
	out, err := s.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
		Bucket: aws.String(s.bucket),
		Delete: &types.Delete{Objects: objects, Quiet: aws.Bool(true)},
	})
	if err != nil {
		return fmt.Errorf("storage: delete %d key(s): %w", len(keys), err)
	}
	if len(out.Errors) > 0 {
		var buf bytes.Buffer
		for i, e := range out.Errors {
			if i > 0 {
				buf.WriteString("; ")
			}
			fmt.Fprintf(&buf, "%s: %s", aws.ToString(e.Key), aws.ToString(e.Message))
		}
		return fmt.Errorf("storage: delete reported per-object errors: %s", buf.String())
	}
	return nil
}

func (s *s3Storage) List(ctx context.Context, prefix string) ([]StoredObject, error) {
	var out []StoredObject
	var continuationToken *string
	for {
		page, err := s.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
			Bucket:            aws.String(s.bucket),
			Prefix:            aws.String(prefix),
			ContinuationToken: continuationToken,
		})
		if err != nil {
			return nil, fmt.Errorf("storage: list %q: %w", prefix, err)
		}
		for _, obj := range page.Contents {
			out = append(out, StoredObject{
				Key:        aws.ToString(obj.Key),
				UploadedAt: aws.ToTime(obj.LastModified),
			})
		}
		if aws.ToBool(page.IsTruncated) && page.NextContinuationToken != nil {
			continuationToken = page.NextContinuationToken
			continue
		}
		break
	}
	return out, nil
}

var _ Storage = (*s3Storage)(nil)
