# The subscription is the permission (11 Oct 2026)

**Brandon's rule, his words:** "If you don't have the subscription you don't get any features. It should be that simple." / "It's by their subscription. ARION pro has different features than ARION lite." / "If they only have ARION they get ARION features. If they only have SPARK they get SPARK features."

This page is the one description of how that rule is enforced. Every later change to a send, a timer, an intake path, a cross-product call or a tier gate is measured against it.

## 1. The one answer

platform-api answers, for one business, `GET /internal/entitlements/:id` (the Portal reads the same answer at `/me/entitlements`):

| Part | What it says |
|---|---|
| `products.oliver / spark / arion / stella / argus` | `owned` (in the subscription or not), `tier` (lite / standard / pro / business), `decided` (true when both the database and Stripe answered) |
| `addons.responder / phone_line / leads_package` | active or not, with its source |
| `limits` | the caps that follow from the tiers |

The platform owner and an agency are answered "owned, business" for everything. Nothing else on the platform decides ownership or tier on its own. Each repo has one client for this answer (`lib/entitlements.js`; iadm-webhooks `src/shared/subscription.js`).

## 2. The same three outcomes everywhere

| The answer | A signed-in read | A send, a cross-product write, a model spend, a background job |
|---|---|---|
| decided, in the subscription | runs | runs |
| decided, NOT in the subscription | 403 with the product named ("SPARK is not in this business's subscription") | refused with the reason: a send is suppressed or skipped (never "failed"), a write is not made, a job leaves the rows untouched |
| undecided (platform-api unreachable, unset, or Stripe unreadable) | allowed, logged (a paying business is never locked out by a hiccup) | HELD: queued row stays queued, event goes back to pending, spend refused; asked again next tick |

Tier comes from the same answer. A null tier on an owned product allows and logs. The feature-to-tier table is `FEATURE_TIER_MATRIX_FULL.md` (section 13 supersedes 1-3 and 10).

## 3. The four doors

1. **Signed-in routes.** LUMEN `requireSparkAccess` + `requireSparkTier` (plus a segment-to-product map for My Brand = ARION, ARGUS = ARGUS; STELLA's SPARK heatmap under SPARK), ARION `requireArionAccess` + `requireArionTier`, OLIVER `requireOliverAccess` + tier limits, STELLA `requireStellaAccess`. Portal: `productAccess.ts` (decided off = the "not in your plan" screen), `navVisibility.ts` (minTier / add-on on every item).
2. **Background jobs.** Every timer in LUMEN, oliver-api, arion-api, arion-func and iadm-webhooks filters its rows through its `productOwnership` helper. These stop only when `ENTITLEMENT_SYNC_MODE=apply`; that setting was never set on production until **13:33Z 11 Oct**, when it was set on all six apps.
3. **Cross-product handoffs.** iadm-webhooks `requireCaptureIntoSpark` (a website inquiry reaches SPARK only when SPARK is in the subscription AND the form has an active `arion.site_form_config` row = "send this form to my SPARK inbox", off until the business turns it on; undecided holds). LUMEN `/internal/intake/website` refuses the same way (second wall), `createInboxLead` the third. arion-api writes a SPARK contact only under the same condition. oliver-api's owner-alert door maps each alert kind to its product and refuses for a product not owned. LUMEN calls OLIVER (cascades, support tickets) only when OLIVER is owned.
4. **The outbox.** iadm-webhooks `notification-processor` judges every email and text by its `source_product` before the preference gate: not in the subscription = suppressed with the reason; undecided = left queued. This is the backstop under every sender in every repo, so `source_product` must be truthful on every row.

## 4. What a business without a product gets

- **Website inquiries without SPARK** stay on the website record (`arion.site_form_submission`), shown on the ARION site page as "Website inquiries"; the site's own form plugin already emails the owner. No SPARK lead, contact, model spend, owner alert or monthly report.
- **A missed call without SPARK** stays in the Conversations inbox; with OLIVER, one OLIVER-worded owner alert; with neither, nothing.
- **A product that ends** stops its timers, its sends, its public booking site (paused screen) and its pages (the "not in your plan" screen with re-subscribe).

## 5. Found on 11 Oct, and why it kept happening

| | |
|---|---|
| app-oliver-api-prod and app-arion-api-prod had no `PLATFORM_API_URL` | every OLIVER and ARION subscription read was "undecided" on production, so every undecided-allows gate fell open. Set 13:31Z. |
| `ENTITLEMENT_SYNC_MODE` unset everywhere | twelve timer checks logged "held" and sent anyway. Set to apply 13:33Z. |
| Website capture into SPARK had no check on any of its four hops | built on purpose in September so "an ARION-only business's enquiry still lands". Reversed. |
| The outbox never looked at the product | the preference gate checks consent only. Product stage added. |

**The check before saying "fixed" from now on:** what does the platform do downstream for a business that does NOT own the product, and can every production app actually reach the one answer (read the app settings, not the code).

## 6. State (kept current on the tracker and the register, D-190 to D-196)

- Config: done and live (13:31Z, 13:33Z).
- iadm-webhooks: built, tested (executed tests, five mutations red), pushed ff70c79, deploy pending.
- LUMEN: website-form owner alert off by default (f5ec3c9, pushed); intake wall and the rest in workflow wf_c2ca6afb-499 with oliver-api and arion-api/arion-func, three skeptics after.
- Portal + arion forms API + plugin capture option: second workflow, queued behind the first.
- Nothing in this page has been clicked in the browser pane yet; the live proof is the one-event replay against the deployed wall and a prod read of the outbox.
