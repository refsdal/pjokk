-- Queries backing GET /api/family/members (Task 9). GetFamilyBySlugless
-- (core.sql) already answers GET /api/family; the auth.sql queries already
-- cover the member-management writes (DeleteFamilyMember,
-- DeleteFamilyMemberRoles, InsertFamilyMemberRole, GetFamilyMember) that
-- auth.Service.RemoveMember/SetMemberRole use.

-- name: ListFamilyMembers :many
-- One row per membership, joined to the user and — like
-- GetFamilyMembershipRole in middleware.sql — the single most-privileged
-- role a member holds, via the same explicit admin/owner/other CASE order
-- rather than a lexicographic one. Pjokk only ever writes one role per
-- membership (SetMemberRole is delete-then-insert); the LATERAL is future
-- proofing against a row ever holding more than one, same as the tenancy
-- gate.
SELECT
    om."id" AS member_id,
    om."user_id",
    COALESCE(u."name", '') AS name,
    u."email",
    COALESCE(r."role", '') AS role,
    u."image"
FROM "organization_members" om
JOIN "users" u ON u."id" = om."user_id"
LEFT JOIN LATERAL (
    SELECT omr."role"
    FROM "organization_member_roles" omr
    WHERE omr."member_id" = om."id"
    ORDER BY CASE omr."role"
        WHEN 'admin' THEN 0
        WHEN 'owner' THEN 1
        ELSE 2
    END, omr."role"
    LIMIT 1
) r ON true
WHERE om."organization_id" = $1
ORDER BY om."created_at";
