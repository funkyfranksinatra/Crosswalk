// Independent recomputation of 8 assertion values from fixture inputs (decimal.js only; no app code).
import Decimal from "decimal.js";
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });
const D = (x) => new Decimal(x);
const cents = (x) => x.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN).toString();
const out = [];
const chk = (label, got, exp) => out.push(`${String(got) === String(exp) ? "OK  " : "DIFF"} ${label}: recomputed=${got} test-expects=${exp}`);
// ws2-policy: DEFAULT_POLICY minMargin 0.3, target 0.45 (from src/lib/pricing/policy-model.ts as documented in BUSINESS_RULES)
chk("floorFor cost 400 min 0.3", D(400).div(D(1).minus(0.3)).toString(), "571.4285714285714285714285714");
chk("target price cost 400 target 0.45 → cents", cents(D(400).div(D(1).minus(0.45))), "727.27");
chk("PENETRATION floor×1.02", cents(D(400).div(D(0.7)).times(1.02)), "582.86");
chk("UNDERCUT_PCT 2.5% of 900", D(900).times(D(1).minus(0.025)).toString(), "877.5");
chk("UNDERCUT_PCT 2.5% of 1234.5 → cents half-even", cents(D("1234.5").times(0.975)), "1203.64");
chk("JPY 0dp of 1203.6375", D("1234.5").times(0.975).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toString(), "1204");
chk("floor cost 800 / 0.7 → cents", cents(D(800).div(0.7)), "1142.86");
chk("discountFromContract (600-500)/600", D(600).minus(500).div(600).toString(), "0.1666666666666666666666666667");
// ws2-economics fixture: E1 1000/400 ×10 (contract 800), E2 500/200 ×20, E3 300/- ×30, E4 80/30 ×2.5; E5 excluded
chk("economics listValue", D(1000).times(10).plus(D(500).times(20)).plus(D(300).times(30)).plus(D(80).times(2.5)).toString(), "29200");
chk("economics contractValue", D(800).times(10).plus(D(500).times(20)).plus(D(300).times(30)).plus(D(80).times(2.5)).toString(), "27200");
chk("economics cogs (E3 has none)", D(400).times(10).plus(D(200).times(20)).plus(D(30).times(2.5)).toString(), "8075");
chk("economics competitorSpend 850×10+450×20+75.5×2.5", D(850).times(10).plus(D(450).times(20)).plus(D("75.5").times(2.5)).toString(), "17688.75");
chk("banker's rounding 777.775 → ", cents(D("777.775")), "777.78");
chk("banker's rounding 444.445 → ", cents(D("444.445")), "444.44");
chk("banker's rounding 70.125 → ", cents(D("70.125")), "70.12");
// ws2-waterfall: rank = precedence>0 ? 10+precedence : natural(LIST0,NAT1,GPO2,IDN3,LOCAL4)
chk("waterfall rank GPO precedence 5", 10 + 5, 15);
chk("waterfall rank LOCAL precedence 1", 10 + 1, 11);
console.log(out.join("\n"));
