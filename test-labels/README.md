<!-- Author: Dr. Ousmane Barry -->
# Sample test labels

Rendered sample labels for testing the app, each with a known expected
outcome. All have been verified end to end through the live app.

## The samples

| Image | Scenario | Expected result |
|---|---|---|
| `old-tom-good.png` | The distilled-spirits example from the project brief, fully compliant | **Pass** (all checks match, including "45% Alc./Vol. (90 Proof)" and the "BOTTLED BY..." statement) |
| `old-tom-bad.png` | ABV printed as 40% instead of 45%; one word changed in the government warning ("due to" instead of "because of") | **Fail** (alcohol content and warning both flagged) |
| `old-tom-titlecase.png` | Warning heading printed as "Government Warning:" in title case, not bold | **Fail** (heading must be GOVERNMENT WARNING in capitals) |
| `old-tom-no-warning.png` | Government warning missing entirely | **Fail** (warning not found) |
| `old-tom-reserve.png` | Label reads "OLD TOM DISTILLERY RESERVE" but the application says "OLD TOM DISTILLERY" | **Needs review** (close but not identical; agent decides) |
| `chateau-riviere.png` | Imported French wine; accented brand "CHÂTEAU RIVIÈRE" vs unaccented application entry; country of origin | **Pass** (accents fold, "France" matches "PRODUCT OF FRANCE") |
| `hop-canyon.png` | Beer can layout where the brewery name is more prominent than the beer name; fluid-ounce net contents | **Pass** (brand is the product name "HOP CANYON", not the brewery; "12 fl oz" matches "12 FL OZ") |

## How to use them

**Single check:** open http://localhost:3000, enter the values from the
matching row of `applications.csv`, add the image, press Check Label.

**Batch check:** open http://localhost:3000/batch, drop `applications.csv`,
then drop all seven PNGs at once. Expected outcome: 3 pass, 3 fail,
1 needs review.

## Regenerating

Each PNG is rendered from the `.html` file of the same name:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --screenshot=old-tom-good.png --window-size=760,1050 \
  --hide-scrollbars "file://$PWD/old-tom-good.html"
```

(`hop-canyon.png` uses `--window-size=900,620`.)
