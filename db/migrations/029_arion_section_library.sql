-- Migration 029: arion.section_library — Elementor section template manifest
--
-- Companion to the AI Website Builder V2 (migrations 024/025/026): the
-- emitters under lib/websiteBuilder/emitters/* currently emit each section
-- from scratch (LLM-generated JSON → elementorAdapter). This manifest plus
-- the matching JSON blobs in Azure Blob `ia-section-library/sections/*`
-- give the emitters a curated 120-section library to inject from instead of
-- (or alongside) the scratch-emit path.
--
-- Library = 12 archetypes × 10 variants = 120 sections, hand-authored by
-- Brandon in the iadm-template-lab WP site and exported to
-- C:/Users/brand/Downloads/iadm-section-library.json. The blueprint_id
-- (e.g. "hero.gradient-dual-cta.v1") is the stable handle the IL calls; it
-- is set on each section's settings._title at authoring time so the row +
-- blob join 1:1 by blueprint_id.
--
-- Archetypes (12): hero, features, pricing, cta, testimonials, about, faq,
--                  team, stats, header, footer, contact.
--
-- 11 sections use the Elementor Pro form widget — those rows carry
-- dependencies = {"pro":true,"plugins":["elementor-pro"]}. The emitter
-- pickers filter by tier so Lite sites never receive a Pro-dependent
-- variant.
--
-- Idempotent. Safe to re-run.
--
-- References:
--   lib/websiteBuilder/sectionLibrary.js               (this migration's primary reader)
--   scripts/upload-section-library.mjs                 (uploader: blob + upsert)
--   handoff: claude-code-handoff-section-library.md    (Brandon's spec)
--   memory: feedback_no_third_party_product_surface.md (all-native widgets only)
--
-- TARGET DB: iadm_services.

IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'arion') EXEC('CREATE SCHEMA arion');

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'section_library' AND schema_id = SCHEMA_ID('arion'))
BEGIN
  CREATE TABLE arion.section_library (
    blueprint_id    NVARCHAR(120)      NOT NULL PRIMARY KEY,   -- e.g. "hero.gradient-dual-cta.v1"
    archetype       NVARCHAR(40)       NOT NULL,               -- 'hero' | 'features' | 'pricing' | ... (12 total)
    variant_key     NVARCHAR(80)       NOT NULL,               -- middle slug — e.g. "gradient-dual-cta"
    axes            NVARCHAR(MAX)      NULL,                   -- JSON: { tone, layout, density, ... } for selection
    dependencies    NVARCHAR(MAX)      NULL,                   -- JSON: { pro: bool, plugins: string[] }
    version         INT                NOT NULL DEFAULT 1,     -- bumps when the underlying blob changes
    status          NVARCHAR(20)       NOT NULL DEFAULT 'active',  -- 'active' | 'deprecated' | 'draft'
    blob_ref        NVARCHAR(400)      NOT NULL,               -- e.g. "sections/hero.gradient-dual-cta.v1.json"
    created_at      DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    updated_at      DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT CK_section_library_status
      CHECK (status IN ('active', 'deprecated', 'draft'))
  );
END;
GO

-- Picker queries always scope by (archetype, status='active'), so the
-- composite index makes the hot-path lookup index-only when version is the
-- only secondary column (small row width keeps the seek cheap).
IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE name = 'IX_section_library_archetype'
    AND object_id = OBJECT_ID('arion.section_library')
)
BEGIN
  CREATE INDEX IX_section_library_archetype
    ON arion.section_library (archetype, status);
END;
GO
