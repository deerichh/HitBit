// BIT starter packs + manifest text parser, ported verbatim from the
// approved BIT demo (hit-for-business-inventory-rounds-demo) so the
// merged app seeds exactly the packs the user signed off on.
//
// Pack item tuple: [name, category, zone, stock (expected book
// count), unit, par, orderUpTo, supplier, sku, tags]. orderUpTo is
// kept in the data for parity with the demo; the order email's
// suggested quantity follows the merged app's rule (par - on hand,
// rounded up to whole packs via each item's pack size).

export interface BitPack {
  defaultName: string;
  zones: string[];
  zoneOptions: string[];
  freezers: string[];
  colors: Record<string, string>;
  items: [
    name: string,
    category: string,
    zone: string,
    stock: number,
    unit: string,
    par: number,
    orderUpTo: number,
    supplier: string,
    sku: string,
    tags: string[],
  ][];
}

// Category colours follow the ONE unified palette (Scheme D,
// Alpha 0.55): six capped, muted slots shared with the household
// side. These hexes are the household-baseline slot colours; at
// render time BitApp maps each category to its palette slot token
// (theme.css --cat-N-dot), which .bit-scope hue-shifts to blue.
export const FALLBACK_COLORS = ["#538d66", "#a18449", "#5d7d9d", "#b0614f", "#876da1", "#478a81"];

const PACKS = {
  "Ice Cream Shop": {
    defaultName: "The Daily Scoop",
    zones: ["Scoop Station", "Front Counter", "Freezer Room", "Dry Storage"],
    zoneOptions: ["Scoop Station", "Front Counter", "Freezer Room", "Dry Storage", "Walk-in Fridge", "Back Room", "Patio Stand"],
    freezers: ["Dipping Cabinet", "Freezer Room"],
    colors: {
      "Ice Cream Tubs & Flavours": "#538d66",
      "Cones & Wafers": "#a18449",
      "Toppings & Sauces": "#5d7d9d",
      "Dairy & Ingredients": "#b0614f",
      "Cups, Spoons & Packaging": "#876da1",
      "Cleaning & Sanitation": "#478a81"
    },
    items: [
      ["Vanilla Bean — 11 L tub", "Ice Cream Tubs & Flavours", "Freezer Room", 4, "11 L tubs", 3, 8, "Scoop Wholesale Co.", "SW-VB-11", ["Gluten-free"]],
      ["Chocolate Fudge — 11 L tub", "Ice Cream Tubs & Flavours", "Freezer Room", 3, "11 L tubs", 3, 8, "Scoop Wholesale Co.", "SW-CF-11", ["Gluten-free"]],
      ["Strawberry — 11 L tub", "Ice Cream Tubs & Flavours", "Freezer Room", 2, "11 L tubs", 3, 8, "Scoop Wholesale Co.", "SW-ST-11", ["Gluten-free"]],
      ["Mint Chocolate Chip — 11 L tub", "Ice Cream Tubs & Flavours", "Freezer Room", 5, "11 L tubs", 3, 8, "Scoop Wholesale Co.", "SW-MC-11", []],
      ["Pistachio — 11 L tub", "Ice Cream Tubs & Flavours", "Freezer Room", 1, "11 L tubs", 2, 6, "Scoop Wholesale Co.", "SW-PI-11", ["Contains nuts"]],
      ["Peanut Butter Swirl — 11 L tub", "Ice Cream Tubs & Flavours", "Freezer Room", 2, "11 L tubs", 2, 6, "Scoop Wholesale Co.", "SW-PB-11", ["Contains nuts"]],
      ["Cookies & Cream — 11 L tub", "Ice Cream Tubs & Flavours", "Freezer Room", 4, "11 L tubs", 3, 8, "Scoop Wholesale Co.", "SW-CC-11", ["Contains gluten"]],
      ["Mango Sorbet — 11 L tub", "Ice Cream Tubs & Flavours", "Freezer Room", 3, "11 L tubs", 2, 6, "Scoop Wholesale Co.", "SW-MS-11", ["Dairy-free", "Gluten-free"]],
      ["Salted Caramel — 11 L tub", "Ice Cream Tubs & Flavours", "Freezer Room", 2, "11 L tubs", 2, 6, "Scoop Wholesale Co.", "SW-SC-11", ["Seasonal"]],
      ["Pumpkin Spice — 11 L tub", "Ice Cream Tubs & Flavours", "Freezer Room", 1, "11 L tubs", 2, 5, "Scoop Wholesale Co.", "SW-PS-11", ["Seasonal"]],
      ["Sugar cones", "Cones & Wafers", "Scoop Station", 2, "cases of 200", 3, 6, "Cone & Wafer Supply", "CW-SC-200", []],
      ["Waffle cones, large", "Cones & Wafers", "Scoop Station", 3, "cases of 120", 3, 6, "Cone & Wafer Supply", "CW-WC-120", ["Contains gluten"]],
      ["Cake cones", "Cones & Wafers", "Scoop Station", 5, "cases of 240", 3, 8, "Cone & Wafer Supply", "CW-CC-240", ["Contains gluten"]],
      ["Waffle bowls", "Cones & Wafers", "Scoop Station", 1, "cases of 60", 2, 5, "Cone & Wafer Supply", "CW-WB-60", ["Contains gluten"]],
      ["Hot fudge sauce", "Toppings & Sauces", "Scoop Station", 4, "3 L jugs", 3, 8, "Scoop Wholesale Co.", "SW-HF-3L", []],
      ["Caramel sauce", "Toppings & Sauces", "Scoop Station", 2, "3 L jugs", 3, 8, "Scoop Wholesale Co.", "SW-CS-3L", []],
      ["Rainbow sprinkles", "Toppings & Sauces", "Scoop Station", 3, "kg", 2, 6, "Scoop Wholesale Co.", "SW-RS-KG", ["Gluten-free"]],
      ["Crushed peanuts", "Toppings & Sauces", "Scoop Station", 1, "kg", 2, 5, "Scoop Wholesale Co.", "SW-CP-KG", ["Contains nuts"]],
      ["Chocolate chips", "Toppings & Sauces", "Dry Storage", 4, "kg", 3, 8, "Scoop Wholesale Co.", "SW-CH-KG", []],
      ["Maraschino cherries", "Toppings & Sauces", "Dry Storage", 2, "jars", 2, 6, "Scoop Wholesale Co.", "SW-MC-JR", []],
      ["Whipping cream", "Dairy & Ingredients", "Freezer Room", 3, "1 L cartons", 6, 12, "Dairyland Direct", "DD-WC-1L", []],
      ["Whole milk 4 L", "Dairy & Ingredients", "Freezer Room", 3, "jugs", 6, 12, "Dairyland Direct", "DD-WM-4L", []],
      ["Sweetened condensed milk", "Dairy & Ingredients", "Dry Storage", 6, "cans", 4, 12, "Dairyland Direct", "DD-CM-CN", []],
      ["Small cups, 4 oz", "Cups, Spoons & Packaging", "Front Counter", 340, "cups", 250, 800, "PackRight", "PR-SC-04", []],
      ["Large cups, 8 oz", "Cups, Spoons & Packaging", "Front Counter", 180, "cups", 250, 800, "PackRight", "PR-LC-08", []],
      ["Tasting spoons", "Cups, Spoons & Packaging", "Scoop Station", 900, "spoons", 500, 2000, "PackRight", "PR-TS-01", []],
      ["Sundae spoons", "Cups, Spoons & Packaging", "Front Counter", 420, "spoons", 300, 1000, "PackRight", "PR-SS-01", []],
      ["Pint take-home tubs + lids", "Cups, Spoons & Packaging", "Front Counter", 64, "tubs", 50, 200, "PackRight", "PR-PT-16", []],
      ["Paper napkins", "Cups, Spoons & Packaging", "Front Counter", 9, "packs", 6, 20, "PackRight", "PR-NP-05", []],
      ["Sanitizer spray", "Cleaning & Sanitation", "Scoop Station", 2, "bottles", 3, 8, "Costco Business Centre", "CBC-SS-750", []],
      ["Food-safe surface wipes", "Cleaning & Sanitation", "Scoop Station", 3, "canisters", 3, 8, "Costco Business Centre", "CBC-FW-01", []],
      ["Dish soap, commercial", "Cleaning & Sanitation", "Dry Storage", 2, "4 L jugs", 2, 6, "Costco Business Centre", "CBC-DS-4L", []],
      ["Disposable gloves, food prep", "Cleaning & Sanitation", "Scoop Station", 1, "boxes of 100", 3, 8, "Costco Business Centre", "CBC-GL-100", []],
      ["Paper towel rolls", "Cleaning & Sanitation", "Dry Storage", 13, "rolls", 10, 30, "Costco Business Centre", "CBC-PT-06", []]
    ]
  },
  "Café / Coffee Shop": {
    defaultName: "Riverside Café & Catering",
    zones: ["Kitchen", "Front Counter", "Storage", "Bar"],
    zoneOptions: ["Kitchen", "Front Counter", "Storage", "Bar", "Walk-in Fridge", "Freezer", "Office", "Stockroom"],
    freezers: ["Freezer"],
    colors: {
      "Coffee & Drinks": "#538d66",
      "Food & Ingredients": "#a18449",
      "Packaging & Service": "#5d7d9d",
      "Cleaning & Janitorial": "#b0614f",
      "Office & Admin": "#876da1",
      "Equipment & Smallwares": "#478a81"
    },
    items: [
      ["Espresso beans, house blend", "Coffee & Drinks", "Storage", 6, "1 kg bags", 8, 20, "Bridgehead Wholesale", "BH-EB-100", []],
      ["Oat milk", "Coffee & Drinks", "Kitchen", 14, "cartons", 12, 36, "Bridgehead Wholesale", "BH-OM-012", ["Gluten-free"]],
      ["Whole milk 4 L", "Coffee & Drinks", "Kitchen", 3, "jugs", 6, 12, "Dairyland Direct", "DD-WM-4L", []],
      ["Orange juice 1.89 L", "Coffee & Drinks", "Kitchen", 9, "bottles", 6, 18, "Dairyland Direct", "DD-OJ-189", []],
      ["Sparkling water", "Coffee & Drinks", "Bar", 22, "cans", 18, 48, "Bridgehead Wholesale", "BH-SW-355", []],
      ["Croissant dough, frozen", "Food & Ingredients", "Kitchen", 4, "cases of 24", 3, 8, "Boulangerie Supply Co.", "BS-CD-24", ["Contains gluten"]],
      ["Butter, unsalted", "Food & Ingredients", "Kitchen", 11, "blocks", 8, 24, "Dairyland Direct", "DD-BU-454", []],
      ["Eggs, free-run large", "Food & Ingredients", "Kitchen", 5, "flats of 30", 4, 10, "Dairyland Direct", "DD-EG-30", []],
      ["All-purpose flour", "Food & Ingredients", "Storage", 2, "10 kg bags", 3, 6, "Boulangerie Supply Co.", "BS-FL-10", ["Contains gluten"]],
      ["Granulated sugar", "Food & Ingredients", "Storage", 7, "2 kg bags", 4, 10, "Boulangerie Supply Co.", "BS-SU-02", []],
      ["Chicken breast, fresh", "Food & Ingredients", "Kitchen", 0, "kg", 5, 15, "Maple Meats", "MM-CB-KG", []],
      ["Mixed salad greens", "Food & Ingredients", "Kitchen", 3, "bags", 4, 10, "Valley Produce", "VP-SG-01", []],
      ["Takeout cups, 12 oz", "Packaging & Service", "Front Counter", 340, "cups", 250, 800, "PackRight", "PR-TC-12", []],
      ["Cup lids, 12 oz", "Packaging & Service", "Front Counter", 180, "lids", 250, 800, "PackRight", "PR-CL-12", []],
      ["Paper napkins", "Packaging & Service", "Front Counter", 9, "packs", 6, 20, "PackRight", "PR-NP-05", []],
      ["Bakery boxes, medium", "Packaging & Service", "Storage", 42, "boxes", 30, 100, "PackRight", "PR-BB-M", []],
      ["Dish soap, commercial", "Cleaning & Janitorial", "Kitchen", 2, "4 L jugs", 2, 6, "CleanSource", "CS-DS-4L", []],
      ["Sanitizer spray", "Cleaning & Janitorial", "Kitchen", 5, "bottles", 4, 12, "CleanSource", "CS-SS-750", []],
      ["Paper towel rolls", "Cleaning & Janitorial", "Storage", 13, "rolls", 10, 30, "CleanSource", "CS-PT-06", []],
      ["Garbage bags, large", "Cleaning & Janitorial", "Storage", 1, "boxes of 100", 2, 5, "CleanSource", "CS-GB-100", []],
      ["Receipt paper rolls", "Office & Admin", "Front Counter", 8, "rolls", 6, 20, "PackRight", "PR-RP-80", []],
      ["Printer paper A4", "Office & Admin", "Storage", 4, "reams", 3, 8, "Staples Business", "SB-PP-A4", []],
      ["Guest cheques pads", "Office & Admin", "Front Counter", 6, "pads", 4, 12, "Staples Business", "SB-GC-50", []],
      ["Bar towels", "Equipment & Smallwares", "Kitchen", 18, "towels", 12, 36, "CleanSource", "CS-BT-12", []],
      ["Portafilter baskets, 58 mm", "Equipment & Smallwares", "Bar", 3, "baskets", 2, 4, "Bridgehead Wholesale", "BH-PF-58", []],
      ["Light bulbs, LED E27", "Equipment & Smallwares", "Storage", 0, "bulbs", 4, 12, "Staples Business", "SB-LB-E27", []]
    ]
  },
  "Restaurant": {
    defaultName: "The Corner Table",
    zones: ["Kitchen", "Walk-in Fridge", "Dry Storage", "Front of House"],
    zoneOptions: ["Kitchen", "Walk-in Fridge", "Dry Storage", "Front of House", "Freezer", "Dish Pit", "Bar"],
    freezers: ["Walk-in Freezer"],
    colors: { "Proteins": "#538d66", "Produce": "#a18449", "Pantry & Dry Goods": "#5d7d9d", "Dairy & Eggs": "#b0614f", "Packaging & Takeout": "#876da1", "Cleaning": "#478a81" },
    items: [
      ["Chicken breast, fresh", "Proteins", "Walk-in Fridge", 4, "kg", 8, 20, "Restaurant Wholesale Co.", "RW-CB-KG", []],
      ["Ground beef 80/20", "Proteins", "Walk-in Fridge", 6, "kg", 8, 20, "Restaurant Wholesale Co.", "RW-GB-KG", []],
      ["Atlantic salmon fillets", "Proteins", "Walk-in Fridge", 0, "kg", 4, 10, "Harbour Seafood", "HS-SF-KG", []],
      ["Roma tomatoes", "Produce", "Walk-in Fridge", 5, "kg", 6, 15, "Valley Produce", "VP-RT-KG", []],
      ["Romaine lettuce", "Produce", "Walk-in Fridge", 3, "cases", 3, 8, "Valley Produce", "VP-RL-CS", []],
      ["Yellow onions", "Produce", "Dry Storage", 12, "kg", 8, 25, "Valley Produce", "VP-YO-KG", []],
      ["Jasmine rice", "Pantry & Dry Goods", "Dry Storage", 2, "10 kg bags", 3, 6, "Restaurant Wholesale Co.", "RW-JR-10", ["Gluten-free"]],
      ["Olive oil", "Pantry & Dry Goods", "Kitchen", 3, "3 L jugs", 3, 8, "Restaurant Wholesale Co.", "RW-OO-3L", []],
      ["Eggs, large", "Dairy & Eggs", "Walk-in Fridge", 4, "flats of 30", 4, 10, "Dairyland Direct", "DD-EG-30", []],
      ["Shredded mozzarella", "Dairy & Eggs", "Walk-in Fridge", 5, "kg", 6, 12, "Dairyland Direct", "DD-MZ-KG", []],
      ["Takeout containers, large", "Packaging & Takeout", "Front of House", 120, "containers", 150, 400, "PackRight", "PR-TC-LG", []],
      ["Sanitizer, food-contact", "Cleaning", "Kitchen", 1, "bottles", 3, 8, "CleanSource", "CS-SF-01", []]
    ]
  },
  "Bar / Pub": {
    defaultName: "The Local Tap",
    zones: ["Bar", "Cellar", "Storage", "Kitchen"],
    zoneOptions: ["Bar", "Cellar", "Storage", "Kitchen", "Patio", "Office"],
    freezers: [],
    colors: { "Spirits": "#538d66", "Beer & Wine": "#a18449", "Mixers & Garnish": "#5d7d9d", "Glassware & Service": "#b0614f", "Cleaning": "#876da1" },
    items: [
      ["House vodka 1.14 L", "Spirits", "Bar", 3, "bottles", 4, 10, "Liquor Wholesale", "LW-VO-114", []],
      ["London dry gin 1.14 L", "Spirits", "Bar", 2, "bottles", 3, 8, "Liquor Wholesale", "LW-GN-114", []],
      ["Bourbon 750 mL", "Spirits", "Bar", 5, "bottles", 4, 10, "Liquor Wholesale", "LW-BO-750", []],
      ["Draught lager — keg", "Beer & Wine", "Cellar", 1, "kegs", 2, 5, "Brewery Direct", "BD-LG-KG", ["Contains gluten"]],
      ["IPA — cans", "Beer & Wine", "Cellar", 36, "cans", 48, 120, "Brewery Direct", "BD-IPA-355", ["Contains gluten"]],
      ["House red wine 750 mL", "Beer & Wine", "Cellar", 8, "bottles", 10, 24, "Wine Merchant", "WM-HR-750", []],
      ["Tonic water", "Mixers & Garnish", "Bar", 18, "cans", 24, 72, "Beverage Wholesale", "BW-TW-355", []],
      ["Fresh limes", "Mixers & Garnish", "Bar", 2, "kg", 3, 8, "Valley Produce", "VP-LM-KG", []],
      ["Simple syrup", "Mixers & Garnish", "Bar", 2, "1 L bottles", 3, 8, "Beverage Wholesale", "BW-SS-1L", []],
      ["Pint glasses", "Glassware & Service", "Bar", 28, "glasses", 36, 72, "Bar Supply Co.", "BS-PG-16", []],
      ["Cocktail napkins", "Glassware & Service", "Bar", 4, "packs", 6, 16, "PackRight", "PR-CN-01", []],
      ["Glass cleaner spray", "Cleaning", "Bar", 1, "bottles", 2, 6, "CleanSource", "CS-GC-750", []]
    ]
  },
  "Bakery": {
    defaultName: "Golden Crust Bakery",
    zones: ["Bakery Kitchen", "Front Counter", "Dry Storage", "Fridge"],
    zoneOptions: ["Bakery Kitchen", "Front Counter", "Dry Storage", "Fridge", "Freezer", "Display Case"],
    freezers: ["Freezer"],
    colors: { "Flour & Baking": "#538d66", "Dairy & Eggs": "#a18449", "Fillings & Toppings": "#5d7d9d", "Packaging": "#b0614f", "Cleaning": "#876da1" },
    items: [
      ["Bread flour", "Flour & Baking", "Dry Storage", 2, "10 kg bags", 3, 7, "Boulangerie Supply Co.", "BS-BF-10", ["Contains gluten"]],
      ["All-purpose flour", "Flour & Baking", "Dry Storage", 3, "10 kg bags", 3, 7, "Boulangerie Supply Co.", "BS-FL-10", ["Contains gluten"]],
      ["Granulated sugar", "Flour & Baking", "Dry Storage", 6, "2 kg bags", 4, 10, "Boulangerie Supply Co.", "BS-SU-02", []],
      ["Active dry yeast", "Flour & Baking", "Dry Storage", 1, "500 g packs", 2, 5, "Boulangerie Supply Co.", "BS-YE-500", []],
      ["Butter, unsalted", "Dairy & Eggs", "Fridge", 9, "blocks", 10, 24, "Dairyland Direct", "DD-BU-454", []],
      ["Eggs, large", "Dairy & Eggs", "Fridge", 5, "flats of 30", 4, 10, "Dairyland Direct", "DD-EG-30", []],
      ["Dark chocolate, baking", "Fillings & Toppings", "Dry Storage", 4, "kg", 3, 9, "Boulangerie Supply Co.", "BS-DC-KG", []],
      ["Wild blueberry filling", "Fillings & Toppings", "Fridge", 2, "tubs", 3, 8, "Boulangerie Supply Co.", "BS-BF-TB", ["Seasonal"]],
      ["Bakery boxes, medium", "Packaging", "Front Counter", 38, "boxes", 40, 120, "PackRight", "PR-BB-M", []],
      ["Parchment sheets", "Packaging", "Bakery Kitchen", 2, "packs", 3, 8, "PackRight", "PR-PS-01", []],
      ["Bread bags", "Packaging", "Front Counter", 140, "bags", 150, 400, "PackRight", "PR-BB-01", []],
      ["Oven cleaner", "Cleaning", "Bakery Kitchen", 1, "bottles", 2, 5, "CleanSource", "CS-OC-01", []]
    ]
  },
  "Retail Store": {
    defaultName: "Main Street Goods",
    zones: ["Sales Floor", "Stockroom", "Front Till", "Window Display"],
    zoneOptions: ["Sales Floor", "Stockroom", "Front Till", "Window Display", "Back Office", "Fitting Rooms"],
    freezers: [],
    colors: { "Best Sellers": "#538d66", "Apparel": "#a18449", "Home Goods": "#5d7d9d", "Seasonal": "#b0614f", "Bags & Packaging": "#876da1", "Cleaning": "#478a81" },
    items: [
      ["Logo tee, medium", "Apparel", "Sales Floor", 14, "units", 12, 36, "Apparel Wholesale", "AW-LT-M", []],
      ["Logo hoodie, large", "Apparel", "Sales Floor", 4, "units", 8, 24, "Apparel Wholesale", "AW-LH-L", []],
      ["Scented candle, cedar", "Home Goods", "Sales Floor", 9, "units", 12, 30, "Home Wholesale", "HW-CC-01", []],
      ["Ceramic mug, house design", "Home Goods", "Sales Floor", 22, "units", 18, 48, "Home Wholesale", "HW-CM-01", []],
      ["Gift set, holiday", "Seasonal", "Window Display", 3, "sets", 8, 24, "Seasonal Wholesale", "SW-GS-HO", ["Seasonal"]],
      ["Reusable shopping bags", "Bags & Packaging", "Front Till", 60, "bags", 80, 250, "PackRight", "PR-RB-01", []],
      ["Small paper bags", "Bags & Packaging", "Front Till", 180, "bags", 200, 600, "PackRight", "PR-SB-01", []],
      ["Price tags, blank", "Bags & Packaging", "Stockroom", 2, "rolls", 3, 8, "Retail Supply Co.", "RS-PT-01", []],
      ["Receipt paper rolls", "Bags & Packaging", "Front Till", 5, "rolls", 6, 20, "PackRight", "PR-RP-80", []],
      ["All-purpose cleaner", "Cleaning", "Stockroom", 2, "bottles", 2, 6, "CleanSource", "CS-AP-01", []],
      ["Glass cleaner", "Cleaning", "Stockroom", 1, "bottles", 2, 5, "CleanSource", "CS-GC-750", []],
      ["AA batteries, display pack", "Best Sellers", "Front Till", 7, "packs", 10, 30, "Retail Supply Co.", "RS-AA-08", []]
    ]
  },
  "Food Truck": {
    defaultName: "Rolling Kitchen",
    zones: ["Truck Kitchen", "Commissary Storage", "Fridge", "Service Window"],
    zoneOptions: ["Truck Kitchen", "Commissary Storage", "Fridge", "Service Window", "Freezer", "Propane Cage"],
    freezers: ["Truck Freezer"],
    colors: { "Proteins": "#538d66", "Produce": "#a18449", "Buns & Wraps": "#5d7d9d", "Sauces & Condiments": "#b0614f", "Packaging": "#876da1", "Cleaning & Fuel": "#478a81" },
    items: [
      ["Burger patties, frozen", "Proteins", "Fridge", 18, "patties", 30, 80, "Restaurant Wholesale Co.", "RW-BP-FR", []],
      ["Chicken thighs", "Proteins", "Fridge", 3, "kg", 6, 15, "Restaurant Wholesale Co.", "RW-CT-KG", []],
      ["Shredded lettuce", "Produce", "Fridge", 2, "bags", 3, 8, "Valley Produce", "VP-SL-BG", []],
      ["Sliced tomatoes", "Produce", "Fridge", 2, "kg", 3, 7, "Valley Produce", "VP-ST-KG", []],
      ["Brioche buns", "Buns & Wraps", "Commissary Storage", 24, "buns", 36, 96, "Boulangerie Supply Co.", "BS-BB-06", ["Contains gluten"]],
      ["Flour tortillas, large", "Buns & Wraps", "Commissary Storage", 30, "wraps", 36, 90, "Boulangerie Supply Co.", "BS-FT-LG", ["Contains gluten"]],
      ["House burger sauce", "Sauces & Condiments", "Truck Kitchen", 1, "2 L jugs", 2, 5, "Restaurant Wholesale Co.", "RW-BS-2L", []],
      ["Ketchup squeeze bottles", "Sauces & Condiments", "Service Window", 4, "bottles", 4, 10, "Restaurant Wholesale Co.", "RW-KC-SQ", []],
      ["Foil wrap sheets", "Packaging", "Service Window", 220, "sheets", 250, 700, "PackRight", "PR-FW-01", []],
      ["Paper boats, large", "Packaging", "Service Window", 90, "boats", 120, 350, "PackRight", "PR-PB-LG", []],
      ["Propane tank, full", "Cleaning & Fuel", "Commissary Storage", 1, "tanks", 2, 4, "Fuel Supplier", "FS-PT-20", []],
      ["Degreaser spray", "Cleaning & Fuel", "Truck Kitchen", 1, "bottles", 2, 5, "CleanSource", "CS-DG-750", []]
    ]
  },
  "Other": {
    defaultName: "My Business",
    zones: ["Main Area", "Storage", "Front Counter", "Back Room"],
    zoneOptions: ["Main Area", "Storage", "Front Counter", "Back Room", "Kitchen", "Fridge", "Freezer", "Office"],
    freezers: ["Freezer"],
    colors: { "Food & Ingredients": "#538d66", "Drinks": "#a18449", "Packaging": "#5d7d9d", "Cleaning & Supplies": "#b0614f", "Office": "#876da1" },
    items: [
      ["House staple item A", "Food & Ingredients", "Storage", 4, "units", 5, 12, "General Wholesale", "GW-A-01", []],
      ["House staple item B", "Food & Ingredients", "Storage", 7, "units", 5, 15, "General Wholesale", "GW-B-01", []],
      ["Fresh milk / main drink base", "Drinks", "Main Area", 3, "units", 6, 12, "General Wholesale", "GW-D-01", []],
      ["Bottled water / canned drinks", "Drinks", "Front Counter", 18, "units", 24, 60, "General Wholesale", "GW-D-02", []],
      ["Takeaway packaging, standard", "Packaging", "Front Counter", 140, "units", 150, 400, "PackRight", "PR-GN-01", []],
      ["Napkins / paper goods", "Packaging", "Front Counter", 5, "packs", 6, 18, "PackRight", "PR-NP-05", []],
      ["All-purpose cleaner", "Cleaning & Supplies", "Storage", 2, "bottles", 2, 6, "CleanSource", "CS-AP-01", []],
      ["Hand soap / sanitizer", "Cleaning & Supplies", "Main Area", 2, "bottles", 3, 8, "CleanSource", "CS-HS-01", []],
      ["Paper towels", "Cleaning & Supplies", "Storage", 9, "rolls", 10, 24, "CleanSource", "CS-PT-06", []],
      ["Receipt / printer paper", "Office", "Front Counter", 4, "rolls", 5, 15, "PackRight", "PR-RP-80", []],
      ["Pens & admin basics", "Office", "Back Room", 6, "packs", 4, 12, "Staples Business", "SB-PN-01", []],
      ["Light bulbs / batteries", "Office", "Storage", 0, "units", 4, 12, "Staples Business", "SB-LB-01", []]
    ]
  }
};

export const PACKS_TYPED = PACKS as unknown as Record<string, BitPack>;
export const BIZ_TYPES: string[] = Object.keys(PACKS);

/**
 * The category options a pack offers in the setup questionnaire:
 * ONE combined list — the pack's categories and its former zones
 * together, all presented as categories, duplicate names merged.
 */
export function packCategoryOptions(pack: BitPack): string[] {
  return [...new Set([...Object.keys(pack.colors), ...pack.zoneOptions])];
}

// Food & beverage oriented business types — every type except
// Retail Store and Other. Only these businesses get freezer checks
// (in the setup review, the Inventory Checks tab, the finish
// summary, and the order email).
export const FOOD_AND_BEVERAGE_TYPES: string[] = [
  "Ice Cream Shop",
  "Café / Coffee Shop",
  "Restaurant",
  "Bar / Pub",
  "Bakery",
  "Food Truck",
];

export function isFoodAndBeverageType(type: string): boolean {
  return FOOD_AND_BEVERAGE_TYPES.includes(type);
}

// ---- Business-type needs profiles (Alpha 0.75) -------------------
// Each business type carries a needs profile, researched per type
// (Nov 14, 2026), that switches on the inventory features that
// type uniquely needs. The profile is keyed off the business's
// stored type — a business created from a questionnaire type (in
// setup, or added later through the same questionnaire) carries
// its type's profile; the server applies the same profiles to
// gate the matching actions, and getBitState returns them on the
// business as `needs`. Freezer temperature checks predate the
// profiles and keep their existing rule (food & beverage types
// with a freezer list); the Ice Cream Shop profile is the one
// whose note calls them out, alongside its new expiry tracking.
export interface BitNeedsProfile {
  /** Items can carry an expiry date; near/past dates are flagged. */
  expiryTracking: boolean;
  /** A waste log in the Inventory tab that deducts stock. */
  wasteLog: boolean;
  /** Inventory Checks accept counts in tenths (open bottles/kegs). */
  fractionalCounting: boolean;
  /** The setup review's "Considered for this business type" note. */
  note: string;
}

const NO_NEEDS: BitNeedsProfile = {
  expiryTracking: false,
  wasteLog: false,
  fractionalCounting: false,
  note: "No type-specific needs — standard inventory.",
};

export const BIT_NEEDS_PROFILES: Record<string, BitNeedsProfile> = {
  "Ice Cream Shop": {
    expiryTracking: true,
    wasteLog: false,
    fractionalCounting: false,
    note: "Freezers must hold −18°C or colder, so freezer temperature checks are on. Dairy and toppings are perishable, so expiry tracking is on.",
  },
  Restaurant: {
    expiryTracking: true,
    wasteLog: true,
    fractionalCounting: false,
    note: "Perishable inventory is tracked by expiry date — use oldest-expiring stock first. A waste log is on for spoilage and expired stock.",
  },
  Bakery: {
    expiryTracking: true,
    wasteLog: false,
    fractionalCounting: false,
    note: "Baked goods and ingredients keep only a few days, so expiry tracking is on — dates are flagged as they near.",
  },
  "Café / Coffee Shop": {
    expiryTracking: true,
    wasteLog: false,
    fractionalCounting: false,
    note: "Milk, cream and pastries are short-dated, so expiry tracking is on for the perishables.",
  },
  "Bar / Pub": {
    expiryTracking: false,
    wasteLog: false,
    fractionalCounting: true,
    note: "Open bottles and kegs are counted by fill level (tenths) during inventory checks.",
  },
  "Food Truck": {
    expiryTracking: true,
    wasteLog: false,
    fractionalCounting: false,
    note: "Storage is tight and stock is perishable, so expiry tracking is on — check dates as you load each day.",
  },
  "Retail Store": { ...NO_NEEDS },
  Other: { ...NO_NEEDS },
};

/** The needs profile for a business type (unknown types get the
    empty profile, exactly like "Other"). */
export function bitNeedsProfile(type: string): BitNeedsProfile {
  return BIT_NEEDS_PROFILES[type] ?? NO_NEEDS;
}

export interface ManifestLine {
  name: string;
  cat: string;
  count: number;
  unit: string;
  par: number | null;
  supplier: string;
}

function splitDelimitedLine(line: string, delim: string): string[] {
  const out: string[] = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
export function parseManifestText(text: string): ManifestLine[] {
  const rawLines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length);
  if (!rawLines.length) return [];
  const first = rawLines[0] ?? "";
  const delim = first.includes("\t") ? "\t" : first.includes(",") ? "," : (first.includes(";") ? ";" : null);
  if (!delim) {
    return rawLines.map((name): ManifestLine => ({ name: name.replace(/^[-•*\d.)\s]+/, "").trim(), cat: "", count: 1, unit: "units", par: null, supplier: "" })).filter((r) => r.name);
  }
  const rowsRaw = rawLines.map((l) => splitDelimitedLine(l, delim));
  const headerCells = (rowsRaw[0] ?? []).map((c) => c.toLowerCase());
  const known = ["name","item","product","category","cat","group","count","quantity","qty","stock","on hand","on-hand","unit","units","par","supplier","vendor"];
  const isHeader = headerCells.some((c) => known.includes(c)) && headerCells.some((c) => ["name","item","product"].includes(c));
  let idx: { name: number; cat: number; count: number; unit: number; par: number; supplier: number } | null = null; let dataRows = rowsRaw;
  if (isHeader) {
    const ix = { name: -1, cat: -1, count: -1, unit: -1, par: -1, supplier: -1 };
    headerCells.forEach((c, i) => {
      if (["name","item","product"].includes(c)) ix.name = i;
      else if (["category","cat","group"].includes(c)) ix.cat = i;
      else if (["count","quantity","qty","stock","on hand","on-hand"].includes(c)) ix.count = i;
      else if (["unit","units"].includes(c)) ix.unit = i;
      else if (c === "par") ix.par = i;
      else if (["supplier","vendor"].includes(c)) ix.supplier = i;
    });
    idx = ix;
    dataRows = rowsRaw.slice(1);
  }
  const out: ManifestLine[] = [];
  for (const cells of dataRows) {
    if (!cells.length || !cells.join("").trim()) continue;
    let r: ManifestLine;
    if (idx) {
      r = { name: cells[idx.name] || "", cat: idx.cat >= 0 ? (cells[idx.cat] || "") : "", count: idx.count >= 0 ? (parseInt(cells[idx.count] ?? "", 10) || 1) : 1, unit: idx.unit >= 0 ? (cells[idx.unit] || "units") : "units", par: idx.par >= 0 ? (parseInt(cells[idx.par] ?? "", 10) || null) : null, supplier: idx.supplier >= 0 ? (cells[idx.supplier] || "") : "" };
    } else if (cells.length >= 2 && /^\d+$/.test((cells[1] ?? "").trim())) {
      r = { name: cells[0] || "", cat: "", count: parseInt(cells[1] ?? "", 10) || 1, unit: cells[2] || "units", par: null, supplier: cells[3] || "" };
    } else {
      r = { name: cells[0] || "", cat: cells[1] || "", count: cells[2] != null && cells[2] !== "" ? (parseInt(cells[2], 10) || 1) : 1, unit: cells[3] || "units", par: cells[4] ? (parseInt(cells[4], 10) || null) : null, supplier: cells[5] || "" };
    }
    r.name = String(r.name || "").trim(); r.cat = String(r.cat || "").trim(); r.unit = String(r.unit || "units").trim() || "units";
    r.count = Math.max(0, Math.floor(Number(r.count) || 0));
    if (r.name) out.push(r);
  }
  return out;
}
