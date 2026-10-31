const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const FormData = require('form-data'); // streaming multipart for staged video uploads
 
const app = express();
// Capture the raw request body ONLY for Shopify webhook routes, so we can verify
// the HMAC signature (JSON parsing otherwise discards the exact bytes Shopify signed).
// Scoped by path to avoid holding large image-upload buffers in memory.
app.use(express.json({limit: '150mb', verify: (req, res, buf) => {
  if (req.url && req.url.startsWith('/webhooks/')) req.rawBody = buf;
}}));
app.use(cors({
  origin: [
    'https://roberthale65-cyber.github.io',
    'https://eternalbloomsbypatti.com',
    'https://eternalbloomsdesigns.com',
    'null'
  ]
}));
// Tag every request so each Airtable call made while serving it is counted against its
// route (see airtableReq / GET /airtable-usage). Record ids are folded to :id.
const atCallCtx = new AsyncLocalStorage();
app.use((req, res, next) => atCallCtx.run({ source: req.method + ' ' + req.path.replace(/rec[A-Za-z0-9]{14}/g, ':id') }, next));
 
const SHOPIFY_API_KEY    = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SHOPIFY_STORE      = process.env.SHOPIFY_STORE;
const SERVER_URL         = process.env.SERVER_URL;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CLIENT_ID   = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const AIRTABLE_TOKEN     = process.env.AIRTABLE_TOKEN;
const PORT               = process.env.PORT || 3000;

// ── Airtable config ───────────────────────────────────────────
const AT_BASE_ID       = 'appHw4SEE5RNT8tCV';
const AT_INVENTORY_TBL = 'tbl29ndzXDXXU8f7x';
const AT_COSTS_TBL     = 'Costs';
const AT_SHIP_PROFILE_MAP_TBL = 'tblvrYkGkIFP9rEPg'; // "Shipping Profile Map": Tier (T1–T4) → Delivery Profile GID

// ── Shopify standard product category (taxonomy) GIDs ─────────
// Map the "Product Category" label (from Airtable / Step 1.1) to a Shopify
// taxonomy node. REST can't set the category, so /create-product sets it via
// a follow-up productUpdate GraphQL mutation. Add-on has no entry on purpose —
// the category is chosen manually on Shopify for those.
const SHOPIFY_CATEGORY_GIDS = {
  'Wreaths':                     'gid://shopify/TaxonomyCategory/hg-3-76-2',
  'Artificial Flowering Plants': 'gid://shopify/TaxonomyCategory/hg-3-2-1'
};

// ── EB color → Shopify "Color" metaobject (shopify.color-pattern) ─────
// Each EB Color(s) value maps to a color-pattern metaobject. The metaobject
// carries the exact EB shade as its label PLUS a color_taxonomy_reference to
// the nearest Shopify standard color, so the native Color filter and
// marketplaces group it correctly while the exact shade still shows. Created
// 2026-06-29 (metaobjectCreate). The Airtable "Value Crosswalk" table is the
// authoritative nearest-color mapping; update both together.
const SHOPIFY_COLOR_METAOBJECTS = {
  'White':         'gid://shopify/Metaobject/214182789255',
  'Silver':        'gid://shopify/Metaobject/246366175367',
  'Bronze':        'gid://shopify/Metaobject/246337962119',
  'Brown':         'gid://shopify/Metaobject/247313924231',
  'Red':           'gid://shopify/Metaobject/214182756487',
  'Orange':        'gid://shopify/Metaobject/245698297991',
  'Yellow':        'gid://shopify/Metaobject/214355935367',
  'Green':         'gid://shopify/Metaobject/214372548743',
  'Blue':          'gid://shopify/Metaobject/214182690951',
  'Purple':        'gid://shopify/Metaobject/214355837063',
  'Pink':          'gid://shopify/Metaobject/214372581511',
  'Gray':          'gid://shopify/Metaobject/248710070407',
  'Black':         'gid://shopify/Metaobject/248710103175',
  'Gold':          'gid://shopify/Metaobject/248710135943',
  'Cream':         'gid://shopify/Metaobject/248710168711',
  'Burgundy':      'gid://shopify/Metaobject/248710201479',
  'Light Blue':    'gid://shopify/Metaobject/248710234247',
  'Lavender':      'gid://shopify/Metaobject/248710267015',
  'Copper':        'gid://shopify/Metaobject/248710299783',
  'Rust':          'gid://shopify/Metaobject/248710332551',
  'Yellow-Orange': 'gid://shopify/Metaobject/248710365319',
  'Teal':          'gid://shopify/Metaobject/248710398087',
  'Peach':         'gid://shopify/Metaobject/248710430855',
  'Beige':         'gid://shopify/Metaobject/248784158855',
  'Navy':          'gid://shopify/Metaobject/248784191623',
  'Clear':         'gid://shopify/Metaobject/248784224391',
  'Multicolor':    'gid://shopify/Metaobject/248784257159',
  'Rose gold':     'gid://shopify/Metaobject/248784289927',
  'Rainbow':       'gid://shopify/Metaobject/248784322695'
};

// Plant name / Suitable location / Pattern → existing metaobject GIDs. Hardcoded
// (NOT runtime query/create) because the 2026-04 Admin API rejects metaobjectCreate
// for these reserved 'shopify--…' definitions and the metaobjects query returns
// empty server-side. Same proven approach as SHOPIFY_COLOR_METAOBJECTS. Values not
// listed here are skipped on publish — add the metaobject in Shopify admin, then
// add its GID here. (Pattern entries live in the color-pattern definition.)
const SHOPIFY_PLANT_METAOBJECTS = {
  'Anemone':'gid://shopify/Metaobject/255705055367','Fern':'gid://shopify/Metaobject/214355804295','Daisy':'gid://shopify/Metaobject/214355902599','Ivy':'gid://shopify/Metaobject/214355968135','Other':'gid://shopify/Metaobject/214356033671','Geranium':'gid://shopify/Metaobject/214392635527','Hydrangea':'gid://shopify/Metaobject/245697446023','Magnolia':'gid://shopify/Metaobject/246351790215','Tulip':'gid://shopify/Metaobject/246352117895','Sunflower':'gid://shopify/Metaobject/246375514247','Spider Mums':'gid://shopify/Metaobject/246375809159','Wisteria':'gid://shopify/Metaobject/246380658823','Decorative Berries Artificial':'gid://shopify/Metaobject/246394093703','Freesia':'gid://shopify/Metaobject/246395240583','Ranunculus':'gid://shopify/Metaobject/246395469959','Rose':'gid://shopify/Metaobject/246395535495','Poppies':'gid://shopify/Metaobject/246539681927','Wax Flowers':'gid://shopify/Metaobject/247317725319','Dahlia':'gid://shopify/Metaobject/247325393031','Pine':'gid://shopify/Metaobject/247325425799','Pansy':'gid://shopify/Metaobject/247338532999','Plum Blossom':'gid://shopify/Metaobject/247340073095','Cherry Blossoms':'gid://shopify/Metaobject/247350919303','Flower Buds':'gid://shopify/Metaobject/247351181447','Ranunculus Roses':'gid://shopify/Metaobject/247775035527','Grape vine':'gid://shopify/Metaobject/247775068295','Wildflower':'gid://shopify/Metaobject/248712396935','Peony':'gid://shopify/Metaobject/248761319559','Aeonium':'gid://shopify/Metaobject/248788811911','Allium':'gid://shopify/Metaobject/248788844679','Alocasia':'gid://shopify/Metaobject/248788877447','Aloe vera':'gid://shopify/Metaobject/248788910215','Amaryllis':'gid://shopify/Metaobject/248788942983','Anthurium':'gid://shopify/Metaobject/248788975751','Aralia':'gid://shopify/Metaobject/248789008519','Aubergine':'gid://shopify/Metaobject/248789041287','Bamboo':'gid://shopify/Metaobject/248789074055','Basil':'gid://shopify/Metaobject/248789106823','Bay leaves':'gid://shopify/Metaobject/248789139591','Begonia':'gid://shopify/Metaobject/248789172359','Bell pepper':'gid://shopify/Metaobject/248789205127','Bird of paradise':'gid://shopify/Metaobject/248789237895','Bonsai':'gid://shopify/Metaobject/248789270663','Bougainvillea':'gid://shopify/Metaobject/248789303431','Boxwood':'gid://shopify/Metaobject/248789336199','Cactus':'gid://shopify/Metaobject/248789368967','Calathea':'gid://shopify/Metaobject/248789401735','Cherry':'gid://shopify/Metaobject/248789434503','Cherry tomato':'gid://shopify/Metaobject/248789467271','Chervil':'gid://shopify/Metaobject/248789500039','Chives':'gid://shopify/Metaobject/248789532807','Chrysanthemum':'gid://shopify/Metaobject/248789565575','Cilantro':'gid://shopify/Metaobject/248789598343','Coriander':'gid://shopify/Metaobject/248789631111','Cotton':'gid://shopify/Metaobject/248789663879','Courgette':'gid://shopify/Metaobject/248789696647','Crocus':'gid://shopify/Metaobject/248789729415','Cucumber':'gid://shopify/Metaobject/248789762183','Curry leaves':'gid://shopify/Metaobject/248789794951','Cyclamen':'gid://shopify/Metaobject/248789827719','Daffodil':'gid://shopify/Metaobject/248789860487','Dandelion':'gid://shopify/Metaobject/248789893255','Dill':'gid://shopify/Metaobject/248789926023','Echeveria':'gid://shopify/Metaobject/248789958791','Echinacea':'gid://shopify/Metaobject/248789991559','Edelweiss':'gid://shopify/Metaobject/248790024327','Eucalyptus':'gid://shopify/Metaobject/248790057095','Fennel':'gid://shopify/Metaobject/248790089863','Ficus':'gid://shopify/Metaobject/248790122631','Fir':'gid://shopify/Metaobject/248790155399','Forsythia':'gid://shopify/Metaobject/248790188167','Galanthus':'gid://shopify/Metaobject/248790220935','Gardenia':'gid://shopify/Metaobject/248790319239','Grass':'gid://shopify/Metaobject/248790352007','Hibiscus':'gid://shopify/Metaobject/248790384775','Honeysuckle':'gid://shopify/Metaobject/248790417543','Hosta':'gid://shopify/Metaobject/248790450311','Hyacinth':'gid://shopify/Metaobject/248790483079','Jasmine':'gid://shopify/Metaobject/248790515847','Lavender':'gid://shopify/Metaobject/248790548615','Lily':'gid://shopify/Metaobject/248790581383','Marigold':'gid://shopify/Metaobject/248790614151','Marjoram':'gid://shopify/Metaobject/248790646919','Mint':'gid://shopify/Metaobject/248790679687','Miscanthus sinensis':'gid://shopify/Metaobject/248790712455','Monstera':'gid://shopify/Metaobject/248790745223','Olive':'gid://shopify/Metaobject/248790777991','Orchid':'gid://shopify/Metaobject/248790810759','Oregano':'gid://shopify/Metaobject/248790843527','Palm':'gid://shopify/Metaobject/248790876295','Pampas grass':'gid://shopify/Metaobject/248790909063','Papyrus':'gid://shopify/Metaobject/248790941831','Parsley':'gid://shopify/Metaobject/248790974599','Petunia':'gid://shopify/Metaobject/248791007367','Phalaenopsis':'gid://shopify/Metaobject/248791105671','Philodendron':'gid://shopify/Metaobject/248791138439','Poinsettia':'gid://shopify/Metaobject/248791171207','Protea':'gid://shopify/Metaobject/248791203975','Rosemary':'gid://shopify/Metaobject/248791236743','Rubber plant':'gid://shopify/Metaobject/248791269511','Sage':'gid://shopify/Metaobject/248791302279','Sansevieria':'gid://shopify/Metaobject/248791335047','Spider plant':'gid://shopify/Metaobject/248791367815','Sweet pea':'gid://shopify/Metaobject/248791400583','Tarragon':'gid://shopify/Metaobject/248791433351','Thyme':'gid://shopify/Metaobject/248791466119','Tomato':'gid://shopify/Metaobject/248791498887','Venus flytrap':'gid://shopify/Metaobject/248791531655','Violet':'gid://shopify/Metaobject/248791564423','Water lily':'gid://shopify/Metaobject/248791597191','Weeping fig':'gid://shopify/Metaobject/248791629959','Willow':'gid://shopify/Metaobject/248791662727','Yarrow':'gid://shopify/Metaobject/248791695495','Yucca':'gid://shopify/Metaobject/248791728263','Zamioculcas':'gid://shopify/Metaobject/248791761031','Zinnia':'gid://shopify/Metaobject/248791793799'
};
const SHOPIFY_LOCATION_METAOBJECTS = {
  'Living room':'gid://shopify/Metaobject/214355869831','Kitchen':'gid://shopify/Metaobject/214356000903','Hallway':'gid://shopify/Metaobject/214356066439','Entrance':'gid://shopify/Metaobject/214356099207','Dining room':'gid://shopify/Metaobject/214356131975','Corridor':'gid://shopify/Metaobject/214356164743','Bedroom':'gid://shopify/Metaobject/214356197511','Bathroom':'gid://shopify/Metaobject/214356230279',"Children's room":'gid://shopify/Metaobject/246375055495','Porch':'gid://shopify/Metaobject/246380986503','Laundry room':'gid://shopify/Metaobject/246386458759','Balcony':'gid://shopify/Metaobject/248791826567','Courtyard':'gid://shopify/Metaobject/248791859335','Garage':'gid://shopify/Metaobject/248791892103','Garden':'gid://shopify/Metaobject/248791924871','Other':'gid://shopify/Metaobject/248791957639','Patio':'gid://shopify/Metaobject/248791990407','Storage room':'gid://shopify/Metaobject/248792023175'
};
const SHOPIFY_PATTERN_METAOBJECTS = {
  'Floral':'gid://shopify/Metaobject/246380920967','Plaid':'gid://shopify/Metaobject/246382624903','Striped':'gid://shopify/Metaobject/246394126471','Abstract':'gid://shopify/Metaobject/248784420999','Animal':'gid://shopify/Metaobject/248784453767','Art':'gid://shopify/Metaobject/248784486535','Bead & reel':'gid://shopify/Metaobject/248784519303','Birds':'gid://shopify/Metaobject/248784552071','Brick':'gid://shopify/Metaobject/248784584839',"Bull's eye":'gid://shopify/Metaobject/248784617607','Camouflage':'gid://shopify/Metaobject/248784650375','Characters':'gid://shopify/Metaobject/248784683143','Checkered':'gid://shopify/Metaobject/248784715911','Chevron':'gid://shopify/Metaobject/248784748679','Chinoiserie':'gid://shopify/Metaobject/248784781447','Christmas':'gid://shopify/Metaobject/248784814215','Collage':'gid://shopify/Metaobject/248784846983','Coral':'gid://shopify/Metaobject/248784879751','Damask':'gid://shopify/Metaobject/248784912519','Diagonal':'gid://shopify/Metaobject/248784945287','Diamond':'gid://shopify/Metaobject/248784978055',"Dog's tooth":'gid://shopify/Metaobject/248785010823','Dots':'gid://shopify/Metaobject/248785043591','Egg & dart':'gid://shopify/Metaobject/248785076359','Ethnic':'gid://shopify/Metaobject/248785109127','Everlasting knot':'gid://shopify/Metaobject/248785141895','Fret':'gid://shopify/Metaobject/248785174663','Geometric':'gid://shopify/Metaobject/248785207431','Guilloche':'gid://shopify/Metaobject/248785240199','Hearts':'gid://shopify/Metaobject/248785272967','Illusion':'gid://shopify/Metaobject/248785305735','Lace':'gid://shopify/Metaobject/248785338503','Leaves':'gid://shopify/Metaobject/248785371271','Logo':'gid://shopify/Metaobject/248785404039','Mosaic':'gid://shopify/Metaobject/248785436807','Ogee':'gid://shopify/Metaobject/248785469575','Organic':'gid://shopify/Metaobject/248785502343','Other':'gid://shopify/Metaobject/248785535111','Paisley':'gid://shopify/Metaobject/248785567879','Rainbow':'gid://shopify/Metaobject/248785600647','Random':'gid://shopify/Metaobject/248785633415','Scale':'gid://shopify/Metaobject/248785666183','Scroll':'gid://shopify/Metaobject/248785698951','Solid':'gid://shopify/Metaobject/248785731719','Stars':'gid://shopify/Metaobject/248785764487','Swirl':'gid://shopify/Metaobject/248785797255','Text':'gid://shopify/Metaobject/248785830023','Texture':'gid://shopify/Metaobject/248785862791','Tie-dye':'gid://shopify/Metaobject/248785895559','Trellis':'gid://shopify/Metaobject/248785928327','Vehicle':'gid://shopify/Metaobject/248785961095'
};
// Additional shopify-namespace taxonomy attributes (same hardcoded-GID approach —
// the Admin API can't query/create these reserved metaobjects, but the values
// below already exist in the store). Harvested via the Shopify MCP 2026-06-30.
// Unlisted values are skipped on publish; add the metaobject in Shopify, then its GID here.
// 'Wall-Door Pocket' metaobject (246336356487) was relabeled to 'Wall/door pocket' in Shopify.
// Retired as Arrangement options (2026-07-01): Centerpiece, Home Decor, Wall Pocket, Planter,
// Pot, and (second pass) Door Decor + Metal Planter — their metaobjects were deleted.
const SHOPIFY_ARRANGEMENT_METAOBJECTS = {
  'Other':'gid://shopify/Metaobject/214355771527','Wall/door pocket':'gid://shopify/Metaobject/246336356487','Vase':'gid://shopify/Metaobject/246395306119','Basket':'gid://shopify/Metaobject/248792055943','Bouquet':'gid://shopify/Metaobject/248792088711','Box':'gid://shopify/Metaobject/248792121479'
};
const SHOPIFY_CONTAINER_METAOBJECTS = {
  'Planter':'gid://shopify/Metaobject/245698363527','Pot':'gid://shopify/Metaobject/246395437191','Vase':'gid://shopify/Metaobject/246395502727','Barrel':'gid://shopify/Metaobject/248792154247','Basket':'gid://shopify/Metaobject/248792187015','Box':'gid://shopify/Metaobject/248792219783','None':'gid://shopify/Metaobject/248792252551','Other':'gid://shopify/Metaobject/248792285319','Urn':'gid://shopify/Metaobject/248792318087'
};
const SHOPIFY_STEM_METAOBJECTS = {
  'Medium':'gid://shopify/Metaobject/246395404423','Long':'gid://shopify/Metaobject/246539714695','Short':'gid://shopify/Metaobject/248750866567','Other':'gid://shopify/Metaobject/248792350855'
};
// Full decoration-material coverage. Last 4 are EB-specific custom metaobjects whose
// taxonomy_reference points at the nearest base value (Grapevine/Pine → Wood, Candle/
// Lights → Other) but keep their own label so they publish AS themselves, not collapsed
// onto the base value's metaobject (created via MCP 2026-06-30).
const SHOPIFY_DECORATION_MATERIAL_METAOBJECTS = {
  'Fabric':'gid://shopify/Metaobject/245698429063','Resin':'gid://shopify/Metaobject/246375317639','Metal':'gid://shopify/Metaobject/246375547015','Silk':'gid://shopify/Metaobject/246375579783','Ceramic':'gid://shopify/Metaobject/246395371655','Wool':'gid://shopify/Metaobject/247312646279','Plastic':'gid://shopify/Metaobject/247339417735','Wood':'gid://shopify/Metaobject/248712364167','Acrylic':'gid://shopify/Metaobject/248786452615','Aluminum':'gid://shopify/Metaobject/248786485383','Bamboo':'gid://shopify/Metaobject/248786518151','Brass':'gid://shopify/Metaobject/248786550919','Bronze':'gid://shopify/Metaobject/248786583687','Canvas':'gid://shopify/Metaobject/248786616455','Capiz':'gid://shopify/Metaobject/248786649223','Cardboard':'gid://shopify/Metaobject/248786681991','Cast iron':'gid://shopify/Metaobject/248786714759','Chrome':'gid://shopify/Metaobject/248786747527','Concrete':'gid://shopify/Metaobject/248786780295','Copper':'gid://shopify/Metaobject/248786813063','Cork':'gid://shopify/Metaobject/248786845831','Cotton':'gid://shopify/Metaobject/248786878599','Crystal':'gid://shopify/Metaobject/248786911367','Faux fur':'gid://shopify/Metaobject/248786944135','Faux leather':'gid://shopify/Metaobject/248786976903','Feathers':'gid://shopify/Metaobject/248787009671','Felt':'gid://shopify/Metaobject/248787042439','Glass':'gid://shopify/Metaobject/248787075207','Hemp':'gid://shopify/Metaobject/248787107975','Iron':'gid://shopify/Metaobject/248787140743','Jute':'gid://shopify/Metaobject/248787173511','Latex':'gid://shopify/Metaobject/248787206279','Leather':'gid://shopify/Metaobject/248787239047','Marble':'gid://shopify/Metaobject/248787271815','Medium density fiberboard (MDF)':'gid://shopify/Metaobject/248787304583','Melamine':'gid://shopify/Metaobject/248787435655','Nylon':'gid://shopify/Metaobject/248787468423','Other':'gid://shopify/Metaobject/248787501191','Paper':'gid://shopify/Metaobject/248787533959','Papier-mâché':'gid://shopify/Metaobject/248787566727','Plush':'gid://shopify/Metaobject/248787599495','Polyester':'gid://shopify/Metaobject/248787632263','Polypropylene (PP)':'gid://shopify/Metaobject/248787665031','Polyvinyl chloride (PVC)':'gid://shopify/Metaobject/248787697799','Porcelain':'gid://shopify/Metaobject/248787730567','Rattan':'gid://shopify/Metaobject/248787763335','Rubber':'gid://shopify/Metaobject/248787796103','Satin':'gid://shopify/Metaobject/248787828871','Sequins':'gid://shopify/Metaobject/248787861639','Silicone':'gid://shopify/Metaobject/248787894407','Stainless steel':'gid://shopify/Metaobject/248787927175','Steel':'gid://shopify/Metaobject/248787959943','Stone':'gid://shopify/Metaobject/248787992711','Suede':'gid://shopify/Metaobject/248788025479','Synthetic':'gid://shopify/Metaobject/248788058247','Terracotta':'gid://shopify/Metaobject/248788091015','Velour':'gid://shopify/Metaobject/248788123783','Velvet':'gid://shopify/Metaobject/248788156551','Veneer':'gid://shopify/Metaobject/248788189319','Vinyl':'gid://shopify/Metaobject/248788222087','Wax':'gid://shopify/Metaobject/248788254855','Zinc':'gid://shopify/Metaobject/248788287623','Grapevine':'gid://shopify/Metaobject/248843829383','Pine':'gid://shopify/Metaobject/248843862151','Candle':'gid://shopify/Metaobject/248843894919','Lights':'gid://shopify/Metaobject/248843927687'
};
// Full planter-material coverage. Galvanized Steel and Basket are EB-specific custom
// metaobjects (taxonomy_reference → Metal / Other) so they keep their own label.
const SHOPIFY_PLANTER_MATERIAL_METAOBJECTS = {
  'Metal':'gid://shopify/Metaobject/245698330759','Ceramic':'gid://shopify/Metaobject/246395338887','Wood':'gid://shopify/Metaobject/247312613511','Resin':'gid://shopify/Metaobject/247317856391','Bamboo':'gid://shopify/Metaobject/248788353159','Concrete':'gid://shopify/Metaobject/248788385927','Glass':'gid://shopify/Metaobject/248788418695','Other':'gid://shopify/Metaobject/248788451463','Plastic':'gid://shopify/Metaobject/248788484231','Stone':'gid://shopify/Metaobject/248788516999','Terracotta':'gid://shopify/Metaobject/248788549767','Galvanized Steel':'gid://shopify/Metaobject/248843960455','Basket':'gid://shopify/Metaobject/248843993223'
};

// Wreath-only taxonomy attributes (created via MCP 2026-06-30).
const SHOPIFY_SHAPE_METAOBJECTS = {
  'Arrow':'gid://shopify/Metaobject/248781078663','Conical':'gid://shopify/Metaobject/248781111431','Custom':'gid://shopify/Metaobject/248781144199','Cylindrical':'gid://shopify/Metaobject/248781176967','Diamond':'gid://shopify/Metaobject/248781209735','Flower':'gid://shopify/Metaobject/248781242503','Free-form':'gid://shopify/Metaobject/248781275271','Heart':'gid://shopify/Metaobject/248781308039','Heptagonal':'gid://shopify/Metaobject/248781340807','Hexagonal':'gid://shopify/Metaobject/248781373575','Kidney-shaped':'gid://shopify/Metaobject/248781406343','Octagonal':'gid://shopify/Metaobject/248781439111','Other':'gid://shopify/Metaobject/248781471879','Oval':'gid://shopify/Metaobject/248781504647','Pentagonal':'gid://shopify/Metaobject/248781537415','Rectangular':'gid://shopify/Metaobject/248781570183','Round':'gid://shopify/Metaobject/246382690439','Semicircular':'gid://shopify/Metaobject/248781602951','Square':'gid://shopify/Metaobject/248781635719','Star':'gid://shopify/Metaobject/248781668487','Trapezoidal':'gid://shopify/Metaobject/248781701255','Triangular':'gid://shopify/Metaobject/248781734023'
};
const SHOPIFY_CELEBRATION_METAOBJECTS = {
  '4th of July':'gid://shopify/Metaobject/246394060935','Anniversary':'gid://shopify/Metaobject/248781766791','Baby gender reveal':'gid://shopify/Metaobject/248781799559','Baby shower':'gid://shopify/Metaobject/247775133831','Birthday':'gid://shopify/Metaobject/247775166599','Christmas':'gid://shopify/Metaobject/248781832327','Concert':'gid://shopify/Metaobject/248781865095','Conference':'gid://shopify/Metaobject/248781897863','Congratulations':'gid://shopify/Metaobject/248781930631','Easter':'gid://shopify/Metaobject/247775199367',"Father's Day":'gid://shopify/Metaobject/248781963399','Get well soon':'gid://shopify/Metaobject/246382657671','Graduation':'gid://shopify/Metaobject/248781996167','Halloween':'gid://shopify/Metaobject/248782028935',"Mother's Day":'gid://shopify/Metaobject/247775232135','New baby':'gid://shopify/Metaobject/247775264903','New home':'gid://shopify/Metaobject/246382755975','Other':'gid://shopify/Metaobject/248782061703','Retirement':'gid://shopify/Metaobject/248782094471','Summer':'gid://shopify/Metaobject/248782127239','Thank you':'gid://shopify/Metaobject/246382788743','Theater performance':'gid://shopify/Metaobject/248782160007','Travel':'gid://shopify/Metaobject/248782192775',"Valentine's day":'gid://shopify/Metaobject/248782225543','Wedding':'gid://shopify/Metaobject/247775101063'
};
const SHOPIFY_LIGHTING_METAOBJECTS = {
  // Verified against the store 2026-06-30: 248750932103 = Illuminated, 246448423047 =
  // Non-illuminated (these two were previously swapped, publishing the wrong value).
  'Illuminated':'gid://shopify/Metaobject/248750932103','Non-illuminated':'gid://shopify/Metaobject/246448423047','Other':'gid://shopify/Metaobject/248782258311'
};

// Every categorised EB piece is artificial — set shopify.plant-material = Artificial
// automatically (not surfaced in Airtable/the tool). Set in its own productUpdate so
// a category that rejects this attribute can't drop the other metafields.
const SHOPIFY_PLANT_MATERIAL_ARTIFICIAL = 'gid://shopify/Metaobject/245698396295';
// Wreaths are synthetic — auto-set shopify.material = Synthetic on every Wreath (own update).
const SHOPIFY_MATERIAL_SYNTHETIC = 'gid://shopify/Metaobject/248782291079';

// Season (shopify.season) — Wreaths only (AFP has no Season attribute). App field is a
// multi-select; "All Season" maps to the All-Season metaobject.
const SHOPIFY_SEASON_METAOBJECTS = {
  'Spring':'gid://shopify/Metaobject/246382723207','Summer':'gid://shopify/Metaobject/248712691847','Fall':'gid://shopify/Metaobject/248712790151','Winter':'gid://shopify/Metaobject/248712953991','All Season':'gid://shopify/Metaobject/248712986759'
};
// Suitable space (shopify.suitable-space) — Wreaths only (AFP uses suitable-location).
// Airtable "Indoor/Outdoor" single-select → Indoor=Indoors, Outdoor=Outdoors, Both=both.
const SHOPIFY_SUITABLE_SPACE = { Indoors:'gid://shopify/Metaobject/214182723719', Outdoors:'gid://shopify/Metaobject/214182658183' };
function mapSuitableSpace(v){
  if (v === 'Indoor') return [SHOPIFY_SUITABLE_SPACE.Indoors];
  if (v === 'Outdoor') return [SHOPIFY_SUITABLE_SPACE.Outdoors];
  if (v === 'Both') return [SHOPIFY_SUITABLE_SPACE.Indoors, SHOPIFY_SUITABLE_SPACE.Outdoors];
  return [];
}
// Indoor/Outdoor → custom.indoor_outdoor (list.single_line_text_field, choices Indoor/Outdoor).
// UNIVERSAL: written on ALL products since AFP has no suitable-space taxonomy attribute;
// wreaths ALSO get the native shopify.suitable-space (above). Both = [Indoor, Outdoor].
function mapIndoorOutdoorList(v){
  if (v === 'Indoor') return ['Indoor'];
  if (v === 'Outdoor') return ['Outdoor'];
  if (v === 'Both') return ['Indoor', 'Outdoor'];
  return [];
}

// The Shopify Wreaths category exposes only "Material" (no Decoration/Planter material
// attributes), so for wreaths we fold the chosen Decoration + Planter materials INTO
// shopify.material, crosswalked to the nearest Material-taxonomy value. Each entry is
// [Material taxonomy label, TaxonomyValue id]; the metaobject is reused-by-label or
// lazily created (see resolveWreathMaterialGids). EB values with no good Material match
// are omitted here and therefore ignored (Capiz, Feathers, Sequins, Wax, Candle,
// Lights, Basket). 'Synthetic' is always added separately.
const WREATH_MATERIAL_TAX = {
  // direct matches (EB value === Material taxonomy value)
  'Fabric':['Fabric',585],'Resin':['Resin',877],'Metal':['Metal',601],'Silk':['Silk',22531],'Ceramic':['Ceramic',643],
  'Wool':['Wool',51],'Plastic':['Plastic',626],'Wood':['Wood',625],'Acrylic':['Acrylic',67],'Aluminum':['Aluminum',1637],
  'Bamboo':['Bamboo',22509],'Brass':['Brass',656],'Bronze':['Bronze',16936],'Canvas':['Canvas',605],'Cardboard':['Cardboard',773],
  'Chrome':['Chrome',665],'Concrete':['Concrete',929],'Copper':['Copper',666],'Cork':['Cork',596],'Cotton':['Cotton',40],
  'Faux fur':['Faux fur',22513],'Faux leather':['Faux leather',52],'Felt':['Felt',22514],'Glass':['Glass',640],'Hemp':['Hemp',22518],
  'Iron':['Iron',860],'Jute':['Jute',22519],'Latex':['Latex',830],'Leather':['Leather',558],'Marble':['Marble',941],
  'Medium density fiberboard (MDF)':['Medium density fiberboard (MDF)',1853],'Nylon':['Nylon',44],'Other':['Other',372],
  'Paper':['Paper',548],'Plush':['Plush',559],'Polyester':['Polyester',45],'Polypropylene (PP)':['Polypropylene (PP)',589],
  'Polyvinyl chloride (PVC)':['Polyvinyl chloride (PVC)',617],'Porcelain':['Porcelain',814],'Rattan':['Rattan',22527],
  'Rubber':['Rubber',764],'Satin':['Satin',22529],'Silicone':['Silicone',809],'Stainless steel':['Stainless steel',620],
  'Stone':['Stone',876],'Suede':['Suede',22532],'Synthetic':['Synthetic',22533],'Velour':['Velour',22537],
  'Velvet':['Velvet',22538],'Vinyl':['Vinyl',624],
  // close-match crosswalks (no exact Material value)
  'Cast iron':['Iron',860],'Crystal':['Glass',640],'Melamine':['Plastic',626],'Papier-mâché':['Paper',548],
  'Steel':['Metal',601],'Terracotta':['Clay',879],'Veneer':['Wood',625],'Zinc':['Metal',601],
  'Grapevine':['Wood',625],'Pine':['Wood',625],'Galvanized Steel':['Metal',601]
};

// Build a wreath's shopify.material GID list: always Synthetic, PLUS the chosen
// Decoration + Planter materials mapped to Material-taxonomy metaobjects. Wreaths only;
// AFP keeps its own decoration/planter keys.
// The Material attribute allows ONE metaobject per taxonomy value, so we RESOLVE BY
// taxonomy_reference: index existing shopify--material metaobjects by the TaxonomyValue
// they reference and reuse them (e.g. "Grapevine" already occupies Wood/625 — reuse it
// rather than fail trying to create a second metaobject for 625). Only create when no
// metaobject yet references that taxonomy value.
async function resolveWreathMaterialGids(body){
  const arr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
  const picks = arr(body.decoration_material).concat(arr(body.planter_material));
  const targets = {};                                    // taxValueId -> canonical label (for creation)
  picks.forEach(v => { const t = WREATH_MATERIAL_TAX[v]; if (t) targets[t[1]] = t[0]; });
  const out = [SHOPIFY_MATERIAL_SYNTHETIC];
  const taxIds = Object.keys(targets);
  if (!taxIds.length) return out;
  // Index existing shopify--material metaobjects by their taxonomy_reference id.
  const byTax = {};
  try {
    let cursor = null;
    do {
      const data = await shopifyGraphql(`query($after:String){metaobjects(type:"shopify--material",first:250,after:$after){edges{node{id fields{key value}}}pageInfo{hasNextPage endCursor}}}`, { after: cursor });
      const conn = data && data.data && data.data.metaobjects; if (!conn) break;
      conn.edges.forEach(e => { const ref = (e.node.fields.find(f => f.key === 'taxonomy_reference') || {}).value; if (ref) byTax[ref.split('/').pop()] = e.node.id; });
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
  } catch (e) { console.warn('material lookup failed:', e.message); }
  for (const taxId of taxIds) {
    let gid = byTax[taxId];
    if (!gid) {
      try {
        const d = await shopifyGraphql(`mutation($mo:MetaobjectCreateInput!){metaobjectCreate(metaobject:$mo){metaobject{id}userErrors{field message}}}`,
          { mo: { type: 'shopify--material', fields: [{ key: 'label', value: targets[taxId] }, { key: 'taxonomy_reference', value: `gid://shopify/TaxonomyValue/${taxId}` }] } });
        gid = d && d.data && d.data.metaobjectCreate && d.data.metaobjectCreate.metaobject && d.data.metaobjectCreate.metaobject.id;
        if (gid) byTax[taxId] = gid;
        else console.warn('material create failed for', targets[taxId], JSON.stringify((d && d.data && d.data.metaobjectCreate && d.data.metaobjectCreate.userErrors) || (d && d.errors) || {}));
      } catch (e) { console.warn('material create error:', e.message); }
    }
    if (gid && !out.includes(gid)) out.push(gid);
  }
  return out;
}

// Which shopify-namespace taxonomy metafields are valid for each product category.
// Shopify REJECTS a productUpdate that sets a metafield outside the category's
// attribute set, so we filter by category before sending. color-pattern is treated
// as universal (works on uncategorised Add-ons too, preserving prior behaviour).
const CATEGORY_METAFIELD_KEYS = {
  'Artificial Flowering Plants': ['plant-name','suitable-location','arrangement','plant-container-type','stem-length','decoration-material','planter-material'],
  // The Shopify Wreaths taxonomy category (hg-3-76-2) has NO decoration-material or
  // planter-material attributes (those would fail the atomic productUpdate and drop the
  // category). Its valid attributes are Color/Pattern (universal), Plant name, Suitable
  // space, Season, Celebration type, Lighting options, Shape (+ auto Material/Plant
  // material). Decoration/planter material for wreaths folds into shopify.material instead.
  'Wreaths': ['plant-name','suitable-space','season','celebration-type','lighting-options','shape']
};

// ── Shopify taxonomy value IDs for lazy metaobject creation ───────────────────
// Used to create missing color-pattern / plant-name / suitable-location
// metaobjects on publish (existing ones are reused by label). Unknown labels
// fall back to the attribute's "Other" value.
const TAX_COLOR_MULTI = 2865; // Multicolor — base color for pattern-only metaobjects
const TAX_PATTERN = {'Abstract':24477,'Animal':24478,'Art':24479,'Bead & reel':24480,'Birds':2283,'Brick':24481,"Bull's eye":24482,'Camouflage':2866,'Characters':2867,'Checkered':2868,'Chevron':24483,'Chinoiserie':24484,'Christmas':2869,'Collage':24485,'Coral':24486,'Damask':24487,'Diagonal':24488,'Diamond':24489,"Dog's tooth":24490,'Dots':2870,'Egg & dart':24491,'Ethnic':24492,'Everlasting knot':24493,'Floral':2871,'Fret':24494,'Geometric':1868,'Guilloche':24495,'Hearts':2375,'Illusion':24496,'Lace':28170,'Leaves':2872,'Logo':24497,'Mosaic':24498,'Ogee':24499,'Organic':24500,'Other':24509,'Paisley':2873,'Plaid':24501,'Rainbow':24502,'Random':24503,'Scale':24504,'Scroll':24505,'Solid':2874,'Stars':2376,'Striped':2875,'Swirl':24506,'Text':1782,'Texture':24507,'Tie-dye':2876,'Trellis':24508,'Vehicle':1796};
const TAX_LOCATION = {'Balcony':10160,'Bathroom':10161,'Bedroom':10162,"Children's room":10163,'Corridor':10164,'Courtyard':10165,'Dining room':10166,'Entrance':19496,'Garage':10168,'Garden':10169,'Hallway':10170,'Kitchen':19497,'Laundry room':10172,'Living room':10173,'Other':19499,'Patio':10174,'Porch':10175,'Storage room':19498,'Toilet':10177};
const TAX_PLANT = {'Aeonium':7842,'Allium':7843,'Alocasia':7844,'Aloe vera':20438,'Amaryllis':7846,'Anthurium':7847,'Aralia':7848,'Aubergine':8603,'Bamboo':20439,'Basil':8604,'Bay leaves':8605,'Begonia':8532,'Bell pepper':8606,'Bird of paradise':8533,'Bonsai':7849,'Bougainvillea':7850,'Boxwood':20440,'Cactus':7852,'Calathea':7853,'Cherry':20441,'Cherry tomato':8607,'Chervil':8608,'Chives':8609,'Chrysanthemum':7855,'Cilantro':8610,'Coriander':8611,'Cotton':20442,'Courgette':8612,'Crocus':8534,'Cucumber':8613,'Curry leaves':8614,'Cyclamen':8535,'Daffodil':8536,'Dahlia':7856,'Daisy':8537,'Dandelion':8538,'Dill':8615,'Echeveria':7857,'Echinacea':20814,'Edelweiss':7858,'Eucalyptus':20443,'Fennel':8616,'Fern':8540,'Ficus':7859,'Fir':7860,'Forsythia':8541,'Galanthus':7861,'Gardenia':8542,'Geranium':8543,'Grape vine':8617,'Grass':20444,'Hibiscus':8544,'Honeysuckle':8546,'Hosta':8545,'Hyacinth':8547,'Hydrangea':7863,'Ivy':7864,'Jasmine':20815,'Lavender':20816,'Lily':8548,'Magnolia':7865,'Marigold':8549,'Marjoram':8618,'Mint':20819,'Miscanthus sinensis':7866,'Monstera':7867,'Olive':20445,'Orchid':7869,'Oregano':8620,'Other':20448,'Palm':7870,'Pampas grass':7871,'Pansy':8550,'Papyrus':7872,'Parsley':8621,'Peony':7873,'Petunia':8551,'Phalaenopsis':7874,'Philodendron':7875,'Pine':20446,'Poinsettia':7876,'Protea':7877,'Ranunculus':7878,'Rose':20447,'Rosemary':20820,'Rubber plant':8552,'Sage':8623,'Sansevieria':7880,'Spider plant':8553,'Sunflower':20817,'Sweet pea':8555,'Tarragon':8624,'Thyme':8625,'Tomato':20821,'Tulip':8556,'Venus flytrap':8557,'Violet':20818,'Water lily':7881,'Weeping fig':8559,'Wildflower':7882,'Willow':770,'Yarrow':8560,'Yucca':8561,'Zamioculcas':7883,'Zinnia':8562};

function shopifyGraphql(query, variables){
  return fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  }).then(r => r.json());
}

// Resolve display labels to metaobject GIDs for a metaobject type, reusing existing
// entries by label (case-insensitive) and creating any missing ones. Non-fatal:
// a label that can't be resolved/created is simply skipped.
async function resolveMetaobjects(moType, labels, makeFields){
  const list = (Array.isArray(labels) ? labels : []).filter(Boolean);
  if (!list.length) return [];
  const existing = {}; let cursor = null;
  try {
    do {
      const data = await shopifyGraphql(`query($type:String!,$after:String){metaobjects(type:$type,first:250,after:$after){edges{node{id displayName}}pageInfo{hasNextPage endCursor}}}`, { type: moType, after: cursor });
      const conn = data && data.data && data.data.metaobjects; if (!conn) break;
      conn.edges.forEach(e => { existing[(e.node.displayName || '').toLowerCase()] = e.node.id; });
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (cursor);
  } catch (e) { console.warn('Metaobject lookup failed for', moType, e.message); }
  const ids = [];
  for (const label of list){
    const key = label.toLowerCase();
    if (existing[key]) { ids.push(existing[key]); continue; }
    try {
      const data = await shopifyGraphql(`mutation($mo:MetaobjectCreateInput!){metaobjectCreate(metaobject:$mo){metaobject{id}userErrors{field message}}}`, { mo: { type: moType, fields: makeFields(label) } });
      const id = data && data.data && data.data.metaobjectCreate && data.data.metaobjectCreate.metaobject && data.data.metaobjectCreate.metaobject.id;
      if (id) { existing[key] = id; ids.push(id); }
      else console.warn('Metaobject create failed for', moType, label, JSON.stringify((data && data.data && data.data.metaobjectCreate && data.data.metaobjectCreate.userErrors) || (data && data.errors) || {}));
    } catch (e) { console.warn('Metaobject create error for', moType, label, e.message); }
  }
  return ids;
}

// ── Token stores ─────────────────────────────────────────────
let shopifyAccessToken = process.env.SHOPIFY_TOKEN || null;
let googleAccessToken  = null;
let googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN || null;
let googleTokenExpiry  = 0;

// ── Airtable helper ───────────────────────────────────────────
// Every call is counted by source (the route that triggered it, or opts.source) so real
// usage is visible at GET /airtable-usage and in the Render logs ("[airtable] ..." lines).
// Counts live in memory, so they reset when the server restarts or sleeps.
const atUsage = { since: new Date().toISOString(), total: 0, rejected: 0, bySource: {}, byDay: {} };
async function airtableReq(tablePath, opts = {}) {
  if (!AIRTABLE_TOKEN) throw new Error('AIRTABLE_TOKEN not configured on server');
  const { source: srcOpt, ...fetchOpts } = opts;
  const method = (fetchOpts.method || 'GET').toUpperCase();
  const source = srcOpt || (atCallCtx.getStore() || {}).source || 'background';
  const day = new Date().toISOString().slice(0, 10);
  atUsage.total++;
  atUsage.bySource[source] = (atUsage.bySource[source] || 0) + 1;
  atUsage.byDay[day] = (atUsage.byDay[day] || 0) + 1;
  console.log(`[airtable] ${method} via ${source} — #${atUsage.total} since ${atUsage.since}`);
  const url = tablePath.startsWith('https://')
    ? tablePath
    : `https://api.airtable.com/v0/${AT_BASE_ID}/${tablePath}`;
  const res = await fetch(url, {
    ...fetchOpts,
    headers: {
      'Authorization': 'Bearer ' + AIRTABLE_TOKEN,
      'Content-Type': 'application/json',
      ...(fetchOpts.headers || {})
    }
  });
  if (!res.ok) {
    if (res.status === 429) atUsage.rejected++;
    const err = await res.json().catch(() => ({}));
    throw new Error('Airtable error ' + res.status + ': ' + JSON.stringify(err));
  }
  const data = await res.json();
  // Any inventory write that returns records refreshes the server's copy of them.
  if (method !== 'GET' && tablePath.startsWith(AT_INVENTORY_TBL)) invCacheUpsert(data);
  return data;
}
const isBillingLimitError = e => /PUBLIC_API_BILLING_LIMIT_EXCEEDED/.test(String((e && e.message) || ''));

// ── Inventory cache ───────────────────────────────────────────
// The app re-downloads the whole inventory (3 calls at ~240 records) on every open,
// refresh and bin QR scan, and the webhooks looked records up one call at a time. The
// server now keeps one copy in memory instead:
//   • served without calling Airtable for INV_FRESH_MS after the last sync;
//   • after that, a DELTA sync fetches only records modified since (usually 1 call),
//     which picks up edits made directly in Airtable;
//   • a FULL reload every INV_FULL_MS (and on cold start) also drops deleted records;
//   • every inventory write that goes through this server updates the copy in place.
const INV_FRESH_MS = 10 * 60 * 1000;
const INV_FULL_MS  = 6 * 60 * 60 * 1000;
const invCache = { byId: new Map(), syncedAt: 0, fullAt: 0, loading: null };
function invCacheUpsert(data) {
  const recs = (data && Array.isArray(data.records)) ? data.records : [data];
  for (const r of recs) if (r && r.id && r.fields) invCache.byId.set(r.id, { id: r.id, createdTime: r.createdTime, fields: r.fields });
}
async function invFetchAll(formula, source) {
  let out = [], offset = null;
  do {
    let path = `${AT_INVENTORY_TBL}?pageSize=100`;
    if (formula) path += '&filterByFormula=' + encodeURIComponent(formula);
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    const data = await airtableReq(path, { source });
    out = out.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);
  return out;
}
// force: sync now even if fresh (delta unless a full reload is due); full: full reload now.
function invEnsure({ force = false, full = false } = {}) {
  const now = Date.now();
  if (!force && !full && invCache.fullAt && now - invCache.syncedAt < INV_FRESH_MS) return Promise.resolve();
  if (invCache.loading) return invCache.loading;
  invCache.loading = (async () => {
    const started = Date.now();
    let doFull = full || !invCache.fullAt || started - invCache.fullAt > INV_FULL_MS;
    if (!doFull) {
      try {
        // 1-minute overlap covers clock skew between this server and Airtable.
        const since = new Date(invCache.syncedAt - 60 * 1000).toISOString();
        invCacheUpsert({ records: await invFetchAll(`IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE('${since}'))`, 'cache:delta') });
      } catch (e) {
        if (isBillingLimitError(e)) throw e;
        console.warn('Inventory delta sync failed — falling back to a full reload:', e.message);
        doFull = true;
      }
    }
    if (doFull) {
      const recs = await invFetchAll(null, 'cache:full');
      invCache.byId = new Map();
      invCacheUpsert({ records: recs });
      invCache.fullAt = started;
    }
    invCache.syncedAt = started;
  })().catch(e => {
    // Airtable unreachable / over its monthly cap: if we already hold a copy, keep serving
    // it (the app stays browsable) and wait 2 minutes before trying again.
    if (!invCache.fullAt) throw e;
    console.warn('Inventory sync failed — serving the cached copy, retrying in 2 min:', e.message);
    invCache.syncedAt = Date.now() - INV_FRESH_MS + 2 * 60 * 1000;
  }).finally(() => { invCache.loading = null; });
  return invCache.loading;
}
function invRecords() { return Array.from(invCache.byId.values()); }
function invFindBySku(sku) { return invRecords().filter(r => String((r.fields || {})['EB Number'] || '').trim() === sku); }

// ── Shipping delivery profiles ────────────────────────────────
// Shopify's weight-based rate engine collapses a multi-item cart into ONE rate, so a
// T1+T4 cart charges only T4 (~one box) instead of T1+T4 (~two boxes). Delivery profiles
// are the native fix: Shopify computes a rate PER profile and SUMS them at checkout. Each
// tier has its own profile holding a single US-wide flat rate, so assigning each variant
// to its tier's profile makes a mixed cart price additively (one box per arrangement).
//
// The tier is recovered from the synthetic ship-weight the publish payload already carries
// (5/15/28/45 lb ⇒ T1..T4 — same Effective Net Charge that drives the Airtable "Shipping
// Tier" formula). The tier→profile-GID mapping is NOT hardcoded: it lives in the Airtable
// "Shipping Profile Map" table so a future profile rebuild is a one-cell edit, no redeploy.
const SHIP_LB_TO_TIER = { 5: 'T1', 15: 'T2', 28: 'T3', 45: 'T4' };

// ── Local-only pieces (pickup / local delivery, cannot ship) ──────────────────
// The "Shipping Profile Map" row with Tier = LOCAL holds the GID of a Shopify delivery
// profile that has NO shipping zones/rates. With local pickup / local delivery enabled on the
// Omaha location, a variant in that profile can only be picked up or delivered locally —
// checkout shows "no shipping available" for an out-of-area address.
//
// NOTE: requires_shipping:false is NOT "local only". It tells Shopify the item isn't
// physical (like a gift card): checkout skips delivery entirely, charges $0 shipping, and
// accepts any buyer anywhere. That's how a Georgia buyer checked out a porch-planter set
// (order #1002). Local-only pieces must stay requires_shipping:true + the LOCAL profile.
const LOCAL_ONLY_TIER = 'LOCAL';
const LOCAL_ONLY_TAG = 'local-only';
const LOCAL_ONLY_NOTICE_HTML = '<p class="eb-local-only"><strong>Local pickup or delivery only (Omaha area).</strong> This piece is too large to ship, so it can’t be sent by mail or carrier. Please order only if you can pick it up or receive local delivery.</p>';

function withLocalOnlyNotice(html) {
  const s = html || '';
  return s.includes('eb-local-only') ? s : LOCAL_ONLY_NOTICE_HTML + s;
}
function withLocalOnlyTag(tags) {
  const list = (Array.isArray(tags) ? tags : String(tags || '').split(',')).map(t => String(t).trim()).filter(Boolean);
  if (!list.some(t => t.toLowerCase() === LOCAL_ONLY_TAG)) list.push(LOCAL_ONLY_TAG);
  return list.join(', ');
}
// Same rule as the client: explicit Airtable "Delivery option" wins; blank defaults from Type.
function isLocalOnlyRecord(f) {
  const opt = (f && f['Delivery option']) || '';
  if (opt) return opt === 'Local only';
  return !!f && f['Type'] === 'Outdoor planter';
}
// Sales channels beyond Online Store and POS. The REST product create only publishes to those
// two, and each of these channels was filled once in bulk when it was set up, so every piece
// listed afterwards was missing from Google until it's published here. Local-only pieces stay
// off them: Google, Facebook and Shop shoppers expect shipping. Needs the write_publications scope.
const EXTRA_SALES_CHANNELS = [
  { name: 'Google & YouTube',     id: 'gid://shopify/Publication/203911430279' },
  { name: 'Facebook & Instagram', id: 'gid://shopify/Publication/198815481991' },
  { name: 'Shop',                 id: 'gid://shopify/Publication/189332422791' }
];
// publish = true adds the product to every extra channel, false removes it. Non-fatal: returns
// 'published' / 'unpublished' or 'failed: …' for the caller's response and logs the reason.
async function setExtraSalesChannels(productGid, sku, publish) {
  const op = publish ? 'publishablePublish' : 'publishableUnpublish';
  try {
    const data = await shopifyGraphql(`mutation($id:ID!,$input:[PublicationInput!]!){ ${op}(id:$id, input:$input){ userErrors { message } } }`,
      { id: productGid, input: EXTRA_SALES_CHANNELS.map(c => ({ publicationId: c.id })) });
    const errs = (data?.errors || data?.data?.[op]?.userErrors || []).map(e => e.message);
    if (errs.length) {
      const hint = errs.some(m => /access denied|write_publications/i.test(m)) ? ' (the Shopify app needs the write_publications scope)' : '';
      console.warn(`sales channels: ${op} for ${sku} failed — ${errs.join(', ')}${hint}`);
      return 'failed: ' + errs.join(', ') + hint;
    }
    console.log(`sales channels: ${sku} ${publish ? 'published to' : 'removed from'} ${EXTRA_SALES_CHANNELS.map(c => c.name).join(', ')}`);
    return publish ? 'published' : 'unpublished';
  } catch (e) {
    console.warn(`sales channels: ${op} for ${sku} failed —`, e.message);
    return 'failed: ' + e.message;
  }
}
async function getLocalOnlyProfileGid() {
  try { return (await getShippingProfileMap())[LOCAL_ONLY_TIER] || null; }
  catch (e) { console.warn('LOCAL profile lookup failed:', e.message); return null; }
}

// Cache the tiny tier→GID crosswalk briefly so we don't re-fetch on every publish, while
// still picking up an Airtable edit within the TTL (that's the whole point of not hardcoding).
let _shipProfileCache = { at: 0, map: null };
async function getShippingProfileMap() {
  const now = Date.now();
  if (_shipProfileCache.map && (now - _shipProfileCache.at) < 5 * 60 * 1000) return _shipProfileCache.map;
  const data = await airtableReq(AT_SHIP_PROFILE_MAP_TBL);
  const map = {};
  for (const rec of (data.records || [])) {
    const tier = String((rec.fields || {})['Tier'] || '').trim();
    const gid  = String((rec.fields || {})['Delivery Profile GID'] || '').trim();
    if (tier && gid) map[tier] = gid;
  }
  _shipProfileCache = { at: now, map };
  return map;
}

// Associate a freshly-created variant with its weight-tier delivery profile. Associating a
// variant with a profile auto-dissociates it from its previous one, so this is idempotent —
// re-publishing or fixing a mis-tiered piece is just the same call again, no cleanup step.
// Fully non-fatal: any miss (blank/unknown weight, missing crosswalk row, Shopify error) logs
// and leaves the variant on the General profile — it never blocks a publish.
//
// Local-only pieces (outdoor planters, anything too big to ship) go to the LOCAL profile
// instead of a weight tier: a Shopify profile with NO shipping rates, so checkout only offers
// local pickup / local delivery from the Omaha location and refuses any ship-to address.
async function assignShippingProfile(sku, variantGid, shipWeightLb, localOnly) {
  const tier = localOnly ? LOCAL_ONLY_TIER : SHIP_LB_TO_TIER[Number(shipWeightLb)];
  if (!tier) {
    console.warn(`ship profile: ${sku} has no recognized ship weight (${shipWeightLb}) — no tier profile assigned (stays on General; piece needs a shipping estimate).`);
    return false;
  }
  let profileGid;
  try {
    profileGid = (await getShippingProfileMap())[tier];
  } catch (e) {
    console.warn(`ship profile: crosswalk lookup failed for ${sku} (${e.message}) — stays on General.`);
    return false;
  }
  if (!profileGid) {
    console.warn(`ship profile: no Delivery Profile GID for tier ${tier} in Shipping Profile Map — ${sku} stays on General.`);
    return false;
  }
  try {
    const mutation = `mutation AssignVariantToProfile($profileId: ID!, $variantId: ID!) {
  deliveryProfileUpdate(id: $profileId, profile: { variantsToAssociate: [$variantId] }) {
    profile { id }
    userErrors { field message }
  }
}`;
    const data = await shopifyGraphql(mutation, { profileId: profileGid, variantId: variantGid });
    if (data?.errors) { console.warn(`ship profile GraphQL error for ${sku}:`, JSON.stringify(data.errors)); return false; }
    const errs = data?.data?.deliveryProfileUpdate?.userErrors || [];
    if (errs.length) { console.warn(`ship profile assign failed for ${sku}:`, errs.map(e => e.message).join(', ')); return false; }
    console.log(`ship profile: ${sku} → ${tier} (${profileGid})`);
    return true;
  } catch (e) {
    console.warn(`ship profile assign error for ${sku} (non-fatal):`, e.message);
    return false;
  }
}

// ── Google token helpers ──────────────────────────────────────
async function getValidGoogleToken() {
  if (googleAccessToken && Date.now() < googleTokenExpiry - 60000) {
    return googleAccessToken;
  }
  if (!googleRefreshToken) throw new Error('Google not connected — visit /drive-auth');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: googleRefreshToken,
      grant_type:    'refresh_token'
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Google token refresh failed: ' + JSON.stringify(d));
  googleAccessToken = d.access_token;
  googleTokenExpiry = Date.now() + (d.expires_in || 3600) * 1000;
  return googleAccessToken;
}

async function driveRequest(path, opts = {}) {
  const token = await getValidGoogleToken();
  const url = path.startsWith('http') ? path : 'https://www.googleapis.com/drive/v3' + path;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Drive API error ' + res.status + ': ' + JSON.stringify(err));
  }
  // 204 No Content — return empty object
  if (res.status === 204) return {};
  return res.json();
}

// ── EXIF orientation for Drive photos ──
// iPhone JPEGs are stored landscape with an EXIF "rotate me" flag (orientation 6/8/3).
// Drive's thumbnailLink ignores that flag, so thumbnails show sideways in the app even
// though the full photo (and the square crop sent to Shopify) is upright. We read just
// the first 128 KB of each JPEG (where EXIF lives) and return the flag so the page can
// rotate the thumbnail. Cached by file ID — a file's bytes don't change under its ID.
const exifOrientationCache = new Map();

function parseJpegOrientation(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return 1;
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xFF) {
    const marker = b[i + 1], len = b.readUInt16BE(i + 2);
    if (marker === 0xDA) break; // start of image data — no EXIF past here
    if (marker === 0xE1 && i + 10 <= b.length && b.toString('ascii', i + 4, i + 8) === 'Exif') {
      const t = i + 10;
      if (t + 8 > b.length) return 1;
      const le = b.toString('ascii', t, t + 2) === 'II';
      const r16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o);
      const r32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
      const ifd = t + r32(t + 4);
      if (ifd + 2 > b.length) return 1;
      const n = r16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 10 > b.length) break;
        if (r16(e) === 0x0112) { const o = r16(e + 8); return o >= 1 && o <= 8 ? o : 1; }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

async function driveExifOrientation(fileId, token) {
  if (exifOrientationCache.has(fileId)) return exifOrientationCache.get(fileId);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { 'Authorization': 'Bearer ' + token, 'Range': 'bytes=0-131071' }
  });
  if (!r.ok) return 1;
  const o = parseJpegOrientation(Buffer.from(await r.arrayBuffer()));
  if (exifOrientationCache.size > 20000) exifOrientationCache.clear();
  exifOrientationCache.set(fileId, o);
  return o;
}

// Adds `orientation` (1–8) to each JPEG in a Drive file list. Best-effort: a failed
// read just leaves the file at 1 (shown as-is), never fails the listing.
async function addExifOrientation(files) {
  const jpegs = files.filter(f => /jpe?g/i.test(f.mimeType || ''));
  if (!jpegs.length) return files;
  const token = await getValidGoogleToken();
  for (let i = 0; i < jpegs.length; i += 8) {
    await Promise.all(jpegs.slice(i, i + 8).map(async f => {
      try { f.orientation = await driveExifOrientation(f.id, token); } catch (e) { f.orientation = 1; }
    }));
  }
  return files;
}

// ── Health check ─────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const checks = {
    server: 'ok',
    token_stored: !!shopifyAccessToken,
    google_connected: !!googleRefreshToken,
    airtable_token: !!AIRTABLE_TOKEN,
    shopify: 'unknown',
    timestamp: new Date().toISOString()
  };
  if (shopifyAccessToken) {
    try {
      const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/shop.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken }
      });
      checks.shopify = r.ok ? 'ok' : 'error ' + r.status;
      if (r.ok) { const d = await r.json(); checks.shop_name = d.shop && d.shop.name; }
      // Report the scopes actually granted to THIS token — the only reliable way
      // to confirm a re-auth expanded permissions (the token string can stay the
      // same across re-consent). Flag whether write_inventory made it through.
      const sr = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_scopes.json`, {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken }
      });
      if (sr.ok) {
        const sd = await sr.json();
        checks.granted_scopes = (sd.access_scopes || []).map(s => s.handle).sort();
        checks.write_inventory_granted = checks.granted_scopes.includes('write_inventory');
        checks.write_publications_granted = checks.granted_scopes.includes('write_publications');
      }
    } catch(e) { checks.shopify = 'error: ' + e.message; }
  } else {
    checks.shopify = 'no token — complete OAuth first';
  }
  res.json(checks);
});
 
// ── Shopify OAuth ─────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${SERVER_URL}/auth/callback`;
  // write_inventory/read_inventory are REQUIRED for inventorySetQuantities — without
  // them the inventory write is silently denied and products land at 0 available.
  // read_orders/read_customers power the sold-order lookup (buyer, address, amount,
  // tracking) for online sales — covers Shopify + Facebook/Instagram Shops, which
  // route their orders through Shopify. NOTE: plain read_orders only returns the last
  // 60 days of orders; older orders need read_all_orders (separate Shopify approval).
  // read_shipping/write_shipping are REQUIRED for deliveryProfileUpdate — without them
  // every weight-tier (T1–T4) and LOCAL profile assignment fails and pieces sit on the
  // General profile (and /apply-local-only refuses).
  // Changing this string requires re-running /auth so Shopify re-grants the scopes —
  // and the callback only holds the new token IN MEMORY: paste it into Render's
  // SHOPIFY_TOKEN or it's lost on the next restart/deploy.
  // write_publications lets a new listing publish itself to Google, Facebook and Shop.
  const scopes = 'read_products,write_products,read_inventory,write_inventory,read_orders,read_customers,read_shipping,write_shipping,read_publications,write_publications';
  const authUrl = `https://${SHOPIFY_STORE}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(authUrl);
});
 
app.get('/auth/callback', async (req, res) => {
  const { code, hmac } = req.query;
  const params = Object.keys(req.query).filter(k => k !== 'hmac').sort().map(k => `${k}=${req.query[k]}`).join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(params).digest('hex');
  if (digest !== hmac) return res.status(400).send('HMAC verification failed');
  try {
    const tokenRes = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code })
    });
    const tokenData = await tokenRes.json();
    if (tokenData.access_token) {
      shopifyAccessToken = tokenData.access_token;
      console.log('✓ Shopify OAuth complete. Set this in Render → SHOPIFY_TOKEN =', shopifyAccessToken);
      res.send(`<html><head><meta charset="utf-8">
        <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Poppins:wght@300;400;500&display=swap" rel="stylesheet">
        <style>body{font-family:'Poppins',system-ui,sans-serif;background:#fbfaf9;color:#2b2622;padding:48px 40px;max-width:560px;margin:0 auto;line-height:1.7}h2{font-family:'DM Serif Display',Georgia,serif;font-weight:400;color:#bb8588;font-size:28px;margin-bottom:10px}p{color:#5b5248;font-size:14px}code{display:block;word-break:break-all;background:#f3f3f6;border:1px solid #e9e6e2;padding:10px 12px;border-radius:6px;font-size:13px;margin:8px 0;font-family:ui-monospace,Menlo,monospace}.warn{font-size:12px;color:#7a4a0a;background:#fefbec;border:1px solid #eea211;border-radius:6px;padding:10px 12px;margin-top:16px}</style>
        </head><body>
        <h2>✓ Shopify connected</h2>
        <p><strong>Make it permanent:</strong> copy the value below into Render as the <code style="display:inline;padding:2px 6px;margin:0">SHOPIFY_TOKEN</code> environment variable, then redeploy. After that, Shopify stays connected across server restarts and you won't need to do this again.</p>
        <code>${shopifyAccessToken}</code>
        <div class="warn">⚠ This is a secret — don't share or screenshot it for anyone. Once SHOPIFY_TOKEN is set in Render you can ignore this page.</div>
        <p style="margin-top:16px">You can close this tab and return to the Studio.</p>
        </body></html>`);
    } else {
      res.status(400).send('Failed to get access token: ' + JSON.stringify(tokenData));
    }
  } catch(e) { res.status(500).send('OAuth error: ' + e.message); }
});

// ── Google Drive OAuth ────────────────────────────────────────
app.get('/drive-auth', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${SERVER_URL}/drive-auth/callback`;
  const scopes = 'https://www.googleapis.com/auth/drive';
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id=' + encodeURIComponent(GOOGLE_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&response_type=code'
    + '&scope=' + encodeURIComponent(scopes)
    + '&access_type=offline'
    + '&prompt=consent'
    + '&state=' + state;
  res.redirect(authUrl);
});

app.get('/drive-auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send('Google auth error: ' + error);
  try {
    const redirectUri = `${SERVER_URL}/drive-auth/callback`;
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code'
      })
    });
    const d = await r.json();
    if (d.access_token) {
      googleAccessToken  = d.access_token;
      if (d.refresh_token) googleRefreshToken = d.refresh_token;  // prompt=consent returns one each time; never overwrite with undefined
      googleTokenExpiry  = Date.now() + (d.expires_in || 3600) * 1000;
      console.log('✓ Google Drive OAuth complete. Set this in Render → GOOGLE_REFRESH_TOKEN =', googleRefreshToken);
      res.send(`<html><head><meta charset="utf-8">
        <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Poppins:wght@300;400;500&display=swap" rel="stylesheet">
        <style>body{font-family:'Poppins',system-ui,sans-serif;background:#fbfaf9;color:#2b2622;padding:48px 40px;max-width:560px;margin:0 auto;line-height:1.7}h2{font-family:'DM Serif Display',Georgia,serif;font-weight:400;color:#bb8588;font-size:28px;margin-bottom:10px}p{color:#5b5248;font-size:14px}code{display:block;word-break:break-all;background:#f3f3f6;border:1px solid #e9e6e2;padding:10px 12px;border-radius:6px;font-size:13px;margin:8px 0;font-family:ui-monospace,Menlo,monospace}.warn{font-size:12px;color:#7a4a0a;background:#fefbec;border:1px solid #eea211;border-radius:6px;padding:10px 12px;margin-top:16px}.muted{font-size:12px;color:#aea498;margin-top:20px}a{color:#bb8588}</style>
        </head><body>
        <h2>✓ Google Drive connected</h2>
        <p><strong>Make it permanent:</strong> copy the value below into Render as the <code style="display:inline;padding:2px 6px;margin:0">GOOGLE_REFRESH_TOKEN</code> environment variable, then redeploy. After that, Drive stays connected across server restarts.</p>
        <code>${googleRefreshToken || '(no refresh token returned — visit /drive-auth again)'}</code>
        <div class="warn">⚠ This is a secret — don't share or screenshot it for anyone. Once GOOGLE_REFRESH_TOKEN is set in Render you can ignore this page.</div>
        <p style="margin-top:16px">You can close this tab and return to the Studio.</p>
        <p class="muted">Health check: <a href="/health">/health</a></p>
        </body></html>`);
    } else {
      res.status(400).send('Failed to get Google token: ' + JSON.stringify(d));
    }
  } catch(e) { res.status(500).send('Google OAuth error: ' + e.message); }
});

// ── Drive: check connection status ───────────────────────────
app.get('/drive-status', async (req, res) => {
  if (!googleRefreshToken) {
    return res.json({ connected: false });
  }
  try {
    await getValidGoogleToken();
    res.json({ connected: true });
  } catch(e) {
    res.json({ connected: false, error: e.message });
  }
});

// ── Drive: list unsorted files in Listing Photos folder root ──
app.get('/drive-list-unsorted', async (req, res) => {
  const { folderId } = req.query;
  if (!folderId) return res.status(400).json({ error: 'folderId required' });
  try {
    const mimeFilter = "(mimeType contains 'image/' or mimeType contains 'video/')";
    const query = `'${folderId}' in parents and ${mimeFilter} and trashed = false`;

    let files = [];
    let pageToken = null;
    do {
      let url = '/files?pageSize=100'
        + '&q=' + encodeURIComponent(query)
        + '&fields=nextPageToken,files(id,name,mimeType,thumbnailLink,webViewLink,properties,size)'
        + '&orderBy=name%20desc';
      if (pageToken) url += '&pageToken=' + pageToken;
      const data = await driveRequest(url);
      files = files.concat(data.files || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);

    const unsorted = files.filter(f => {
      const props = f.properties || {};
      return props.sorted !== 'true';
    });
    await addExifOrientation(unsorted);

    res.json({ files: unsorted, total: unsorted.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Drive: ensure subfolder path exists, return folder ID ────
async function ensureFolder(parentId, folderName) {
  const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name = '${folderName.replace(/'/g, "\\'")}' and trashed = false`;
  const data = await driveRequest('/files?q=' + encodeURIComponent(query) + '&fields=files(id,name)');
  if (data.files && data.files.length > 0) return data.files[0].id;
  const created = await driveRequest('/files', {
    method: 'POST',
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    })
  });
  return created.id;
}

// ── Drive: apply sort to one or more files ───────────────────
app.post('/drive-sort-files', async (req, res) => {
  const { rootFolderId, fileIds, season, type, holiday } = req.body;
  if (!rootFolderId || !fileIds || !fileIds.length || !season || !type) {
    return res.status(400).json({ error: 'rootFolderId, fileIds, season, and type are required' });
  }

  try {
    const seasonFolderId = await ensureFolder(rootFolderId, season);
    const typeFolderId   = await ensureFolder(seasonFolderId, type);

    const results = [];
    for (const fileId of fileIds) {
      try {
        const meta = await driveRequest(`/files/${fileId}?fields=parents,name`);
        const currentParents = (meta.parents || []).join(',');

        const properties = { sorted: 'true', season, type };
        if (holiday && holiday !== 'None') properties.holiday = holiday;

        const moveUrl = `/files/${fileId}`
          + '?addParents=' + typeFolderId
          + (currentParents ? '&removeParents=' + currentParents : '')
          + '&fields=id,name,parents,properties';

        const updated = await driveRequest(moveUrl, {
          method: 'PATCH',
          body: JSON.stringify({ properties })
        });

        results.push({ fileId, success: true, name: updated.name, folderId: typeFolderId });
      } catch(fileErr) {
        results.push({ fileId, success: false, error: fileErr.message });
      }
    }

    const allOk = results.every(r => r.success);
    res.json({ success: allOk, results, seasonFolderId, typeFolderId });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Drive: rename files with EB number ───────────────────────
app.post('/drive-assign-eb', async (req, res) => {
  const { fileIds, ebNumber } = req.body;
  if (!fileIds || !fileIds.length || !ebNumber) {
    return res.status(400).json({ error: 'fileIds and ebNumber are required' });
  }

  try {
    const results = [];
    for (let i = 0; i < fileIds.length; i++) {
      const fileId = fileIds[i];
      try {
        const meta = await driveRequest(`/files/${fileId}?fields=name,properties`);
        const ext = meta.name.includes('.') ? '.' + meta.name.split('.').pop().toLowerCase() : '';
        const seq = String(i + 1).padStart(2, '0');
        const newName = `${ebNumber}_${seq}${ext}`;

        const updated = await driveRequest(`/files/${fileId}?fields=id,name,properties`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: newName,
            properties: { ...(meta.properties || {}), eb_number: ebNumber }
          })
        });

        results.push({ fileId, success: true, oldName: meta.name, newName: updated.name });
      } catch(fileErr) {
        results.push({ fileId, success: false, error: fileErr.message });
      }
    }
    res.json({ success: results.every(r => r.success), results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Drive: move a piece's photo folder between buckets (Sorted → Published / Sold) ──
// Keeps the "Listing media sorted" folder picker lean: published pieces move to Published,
// sold pieces (from ANY channel — the trigger is Airtable Status) move to Sold.
// Idempotent: if the folder already lives under the destination it's a no-op. Removes the
// folder from ALL current parents and adds the destination, so it works from wherever the
// folder currently sits. The Drive folder ID is stable across moves, so Airtable's stored
// "Drive Folder ID" (and photo loading by that ID) keeps working.
const DRIVE_BUCKETS = {
  sorted:    '1eBdFF0uzt6zsBYCG344xSyochu6ApL0s', // Listing media sorted
  published: '19f9Sb47CN64eaqBpz7iWrjiNjtgcREnu', // Published
  sold:      '1RT7hCfO2PJcNnSRiC2Y6pUDaIHWcPhUu'  // Sold
};
app.post('/drive-move-folder', async (req, res) => {
  const { folderId, destination } = req.body || {};
  if (!folderId) return res.status(400).json({ error: 'folderId required' });
  const destId = DRIVE_BUCKETS[destination] || (/^[\w-]{20,}$/.test(destination || '') ? destination : null);
  if (!destId) return res.status(400).json({ error: 'destination must be one of: ' + Object.keys(DRIVE_BUCKETS).join(', ') + ' (or a folder id)' });
  try {
    const meta = await driveRequest(`/files/${folderId}?fields=id,name,parents&supportsAllDrives=true`);
    const current = meta.parents || [];
    if (current.includes(destId)) {
      return res.json({ success: true, moved: false, name: meta.name, note: 'already in destination' });
    }
    let url = `/files/${folderId}?addParents=${encodeURIComponent(destId)}&fields=id,name,parents&supportsAllDrives=true`;
    if (current.length) url += `&removeParents=${encodeURIComponent(current.join(','))}`;
    const updated = await driveRequest(url, { method: 'PATCH', body: JSON.stringify({}) });
    res.json({ success: true, moved: true, name: updated.name, parents: updated.parents });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drive: list subfolders under a parent (for the stepped-workflow folder picker) ──
app.get('/drive-list-subfolders', async (req, res) => {
  const { parentId } = req.query;
  if (!parentId) return res.status(400).json({ error: 'parentId required' });
  try {
    const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    let folders = [], pageToken = null;
    do {
      let url = '/files?pageSize=100&q=' + encodeURIComponent(query)
        + '&fields=nextPageToken,files(id,name)&orderBy=name';
      if (pageToken) url += '&pageToken=' + pageToken;
      const data = await driveRequest(url);
      folders = folders.concat(data.files || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    res.json({ folders, total: folders.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drive: list image files in a specific folder ──
app.get('/drive-folder-images', async (req, res) => {
  const { folderId } = req.query;
  if (!folderId) return res.status(400).json({ error: 'folderId required' });
  try {
    const query = `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`;
    let files = [], pageToken = null;
    do {
      let url = '/files?pageSize=100&q=' + encodeURIComponent(query)
        + '&fields=nextPageToken,files(id,name,mimeType,thumbnailLink)&orderBy=name';
      if (pageToken) url += '&pageToken=' + pageToken;
      const data = await driveRequest(url);
      files = files.concat(data.files || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    await addExifOrientation(files);
    res.json({ files, total: files.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drive: fetch full file content as base64 (for the Shopify upload / AI vision) ──
app.get('/drive-file-content', async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) return res.status(400).json({ error: 'fileId required' });
  try {
    const token = await getValidGoogleToken();
    const meta = await driveRequest(`/files/${fileId}?fields=mimeType,name`);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Drive download error ' + r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    res.json({ data: buf.toString('base64'), mime: meta.mimeType || 'image/jpeg', name: meta.name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drive: upload a generated image (e.g. a square crop) into a folder ──
// Used to save the "_square_" listing crops alongside the untouched originals.
// If a file of the same name already exists in the folder, its bytes are
// updated in place so re-publishing a piece never piles up duplicates.
app.post('/drive-upload-image', async (req, res) => {
  const { folderId, name, dataBase64, mimeType, ebNumber, sourceFileId } = req.body;
  if (!folderId || !name || !dataBase64) return res.status(400).json({ error: 'folderId, name and dataBase64 are required' });
  try {
    const token = await getValidGoogleToken();
    const mime  = mimeType || 'image/jpeg';
    const bytes = Buffer.from(dataBase64, 'base64');
    const properties = { eb_number: ebNumber || '', variant: 'square' };
    if (sourceFileId) properties.source_file_id = sourceFileId;

    // Reuse an existing same-named file in the folder rather than duplicating it.
    const q = `name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`;
    const existing = await driveRequest('/files?q=' + encodeURIComponent(q) + '&fields=files(id)');
    const existingId = existing.files && existing.files[0] && existing.files[0].id;

    const metadata = existingId ? { name, properties } : { name, parents: [folderId], properties };
    const boundary = 'ebupload' + Date.now();
    const pre  = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` + JSON.stringify(metadata) + `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, 'utf8');
    const post = Buffer.from(`\r\n--${boundary}--`, 'utf8');
    const body = Buffer.concat([pre, bytes, post]);

    const uploadUrl = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&fields=id,name`
      : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name`;
    const up = await fetch(uploadUrl, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    if (!up.ok) { const t = await up.text().catch(() => ''); throw new Error('Drive upload failed ' + up.status + ': ' + t.slice(0, 200)); }
    const out = await up.json();
    res.json({ success: true, id: out.id, name: out.name, updated: !!existingId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Airtable: inventory endpoints ────────────────────────────

// GET /airtable/inventory — fetch all inventory records (paginated)
// Served from the inventory cache as ONE response (no offset, so the app's paging loop
// ends after one request). ?refresh=1 syncs changes first; ?refresh=full reloads all.
app.get('/airtable/inventory', async (req, res) => {
  try {
    await invEnsure({ force: req.query.refresh === '1', full: req.query.refresh === 'full' });
    res.json({ records: invRecords() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /airtable/inventory/:id — fetch single inventory record
app.get('/airtable/inventory/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await invEnsure();
    const cached = invCache.byId.get(id);
    if (cached) return res.json(cached);
    const data = await airtableReq(`${AT_INVENTORY_TBL}/${id}`);
    invCacheUpsert(data);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Airtable call counts since the server last started, by source and by day, plus the
// inventory cache's state. The workspace is on the Team plan (upgraded from Free, 2026-10).
app.get('/airtable-usage', (req, res) => {
  res.json({ ...atUsage, cache: { records: invCache.byId.size,
    lastSync: invCache.syncedAt ? new Date(invCache.syncedAt).toISOString() : null,
    lastFullReload: invCache.fullAt ? new Date(invCache.fullAt).toISOString() : null } });
});

// POST /airtable/inventory — create (or upsert) an inventory record.
// Upserts on EB Number so the SAME SKU can never spawn a duplicate record — e.g. a
// double-submit, a slow-network retry, or two rapid creates that computed the same
// next EB number. If a record with this EB Number already exists it is UPDATED in
// place (atomic, via Airtable performUpsert); otherwise a new record is created.
// "Mark as sold" already updates by record id, so this closes the remaining gap:
// duplicate EB Numbers can no longer be created. Records without an EB Number
// (shouldn't happen for inventory) fall back to a plain create.
app.post('/airtable/inventory', async (req, res) => {
  const { fields } = req.body;
  if (!fields) return res.status(400).json({ error: 'fields required' });
  try {
    if (fields['EB Number']) {
      const data = await airtableReq(AT_INVENTORY_TBL, {
        method: 'PATCH',
        body: JSON.stringify({
          performUpsert: { fieldsToMergeOn: ['EB Number'] },
          records: [{ fields }],
          typecast: true
        })
      });
      // Return the single record in the same shape a plain create returns.
      return res.json((data.records && data.records[0]) || data);
    }
    const data = await airtableReq(AT_INVENTORY_TBL, {
      method: 'POST',
      body: JSON.stringify({ fields, typecast: true })
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /airtable/inventory/:id — update inventory record
app.patch('/airtable/inventory/:id', async (req, res) => {
  const { id } = req.params;
  const { fields } = req.body;
  if (!id || !fields) return res.status(400).json({ error: 'id and fields required' });
  try {
    const data = await airtableReq(`${AT_INVENTORY_TBL}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields, typecast: true })
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Airtable: costs endpoints ─────────────────────────────────

// GET /airtable/costs — fetch all cost records (paginated, newest first)
app.get('/airtable/costs', async (req, res) => {
  const { offset } = req.query;
  try {
    let path = encodeURIComponent(AT_COSTS_TBL) + '?pageSize=100&sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=desc';
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    const data = await airtableReq(path);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /airtable/costs — create new cost record
app.post('/airtable/costs', async (req, res) => {
  const { fields } = req.body;
  if (!fields) return res.status(400).json({ error: 'fields required' });
  try {
    const data = await airtableReq(encodeURIComponent(AT_COSTS_TBL), {
      method: 'POST',
      body: JSON.stringify({ fields, typecast: true })
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH /airtable/costs/:id — update cost record
app.patch('/airtable/costs/:id', async (req, res) => {
  const { id } = req.params;
  const { fields } = req.body;
  if (!id || !fields) return res.status(400).json({ error: 'id and fields required' });
  try {
    const data = await airtableReq(`${encodeURIComponent(AT_COSTS_TBL)}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields, typecast: true })
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Airtable: Bins registry ─────────────────────────────────
// GET /airtable/bins — list all printed bin records
app.get('/airtable/bins', async (req, res) => {
  try {
    const url = `https://api.airtable.com/v0/${AT_BASE_ID}/Bins?sort%5B0%5D%5Bfield%5D=Bin+Number&sort%5B0%5D%5Bdirection%5D=asc`;
    const data = await airtableReq(url);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /airtable/bins — register a newly printed bin
app.post('/airtable/bins', async (req, res) => {
  try {
    const { fields } = req.body;
    if (!fields) return res.status(400).json({ error: 'fields required' });
    // typecast lets Airtable auto-create a missing 'Type' single-select choice,
    // so adding a storage type to BM_TYPES needs no manual Airtable edit.
    const data = await airtableReq('Bins', {
      method: 'POST',
      body: JSON.stringify({ fields, typecast: true })
    });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Helper: look up collection ID by handle ──────────────────
async function getCollectionId(handle) {
  const customRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/custom_collections.json?handle=${handle}`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
  const customData = await customRes.json();
  if (customData.custom_collections && customData.custom_collections.length > 0) return customData.custom_collections[0].id;
  const smartRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/smart_collections.json?handle=${handle}`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
  const smartData = await smartRes.json();
  if (smartData.smart_collections && smartData.smart_collections.length > 0) return smartData.smart_collections[0].id;
  return null;
}
 
// ── Generate description ──────────────────────────────────────
app.post('/generate-description', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });
  const { eb_number, reference_name, type, season, holiday, colors, dimensions, materials, location, special, notes, images, florals, greenery } = req.body;
  // Florals/Greenery are NOT structured data — they only inform the copy. Real-touch florals
  // and premium greenery are upgrades worth touting; silk florals and standard greenery are
  // baseline and must NOT be called out.
  const premiumBits = [];
  if ((florals || '').toLowerCase() === 'real-touch') premiumBits.push('real-touch, lifelike flowers');
  if ((greenery || '').toLowerCase() === 'premium') premiumBits.push('premium greenery');
  const textPrompt = `You write product listings for Eternal Blooms Designs, a handmade artificial flower arrangement business. Each piece is handmade and one of a kind.

Write a Shopify product listing for this piece: a TITLE, a DESCRIPTION, and an SEO_META.

TITLE — a Shopify-SEO-optimized product title, BETWEEN 60 AND 80 CHARACTERS long (count the characters; this range optimizes for SEO and avoids search-result truncation — never go under 60 or over 80).
- Begin with the clearest PRIMARY KEYWORD — the exact term a shopper is most likely to search for (usually the arrangement type with its standout descriptor, e.g. "Fall Door Wreath", "Floral Centerpiece"). It must come at the very beginning.
- Use the Maker's working name / Reference name (in the piece details below) as your BASE, then refine and expand it into a polished, keyword-led title that satisfies these rules.
- Use Title Case (capitalize the first letter of every significant word).
- Write any numbers as digits (e.g. "3", never "three").
- Do NOT include any EB/SKU code, quotation marks, or the word "title".

DESCRIPTION — return as clean, minimal HTML; it is published directly as the Shopify product description. Aim for 150–400 words of scannable, engaging, boutique-style copy. Write ABOUT the piece, not the maker — no first person ("I", "my"), and no mention of Patti or any maker.
- FRONT-LOAD the single most compelling benefit in the first one or two sentences so mobile shoppers see it immediately, and include the PRIMARY KEYWORD in that opening sentence.
- Keep every paragraph to 2–3 sentences maximum to avoid walls of text on mobile.
- Use ONE short bold sub-header before the detail list (and optionally one more) to break up sections and create white space.
- Include a structured BULLET LIST of concrete details: colors, key flowers/materials, best display location, and seasonal or occasion fit. (Exact dimensions are appended automatically after your description — do NOT list them.)
- Naturally weave in keyword synonyms throughout for SEO, without keyword-stuffing.
- Allowed HTML tags ONLY, and with NO attributes: <p>, <strong>, <ul>, <li>, <br>. Use <p><strong>Sub-header</strong></p> for a bold header. Do NOT use markdown, heading tags, inline styles, classes, or any tag attributes.
- You may describe the piece as handmade and one-of-a-kind, but do NOT claim or imply it cannot be reproduced, recreated, or replicated. Never use phrasing such as "can never be exactly duplicated," "no two are ever the same," "impossible to recreate," or any similar wording suggesting the item is unrepeatable.
- Do NOT mention any business location, city, or state (e.g. Omaha, or Nebraska/NE), or where the piece is made or ships from.
- ${premiumBits.length ? 'Material quality to highlight as a genuine selling benefit: ' + premiumBits.join(' and ') + '. Weave it in naturally as an upgrade shoppers will value.' : 'Do NOT tout flower or greenery material grade — this piece uses baseline materials (standard silk flowers / standard greenery), which are not selling points.'}
- Return the HTML as a SINGLE LINE with no literal line breaks inside the JSON string.${images && images.length > 0 ? '\n\nPhoto(s) of the actual piece are attached — use what you can see in the photos to write the most accurate, keyword-rich title and description possible.' : ''}

Piece details:
- Type: ${type || 'arrangement'}
- Season: ${season || 'all season'}
- Occasion: ${holiday && holiday !== 'None' ? holiday : 'none'}
- Colors: ${colors || 'not specified'}
- Dimensions: ${dimensions || 'not specified'}
- Key materials / flowers: ${materials || 'not specified'}
- Best display location: ${location || 'not specified'}
- Maker notes: ${(notes || '') + (special ? ' ' + special : '') || 'none'}
- Maker's working name / Reference name (use this as the BASE for the title, refined and expanded for SEO; you may also draw on it for the description): ${reference_name || 'none'}

SEO_META — a Google meta description for search results, 140-160 characters. Must include 2-3 of the strongest keywords from the title. Describe the piece enticingly as if coaxing a click. Do not open with the exact title text. Do not exceed 160 characters.

Return ONLY valid JSON in exactly this shape, with no markdown, no code fences, and no text before or after:
{"title": "...", "description": "...", "seo_meta": "..."}`;

  let messageContent;
  if (images && images.length > 0) {
    messageContent = [];
    for (const img of images) {
      const validTypes = ['image/jpeg','image/png','image/gif','image/webp'];
      const mime = validTypes.includes(img.mime) ? img.mime : 'image/jpeg';
      messageContent.push({ type: 'image', source: { type: 'base64', media_type: mime, data: img.data } });
    }
    messageContent.push({ type: 'text', text: textPrompt });
  } else {
    messageContent = textPrompt;
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1200, messages: [{ role: 'user', content: messageContent }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    const raw = data.content && data.content[0] && data.content[0].text ? data.content[0].text.trim() : '';
    // Model is asked for {"title","description","seo_meta"} JSON; parse tolerantly and fall back to raw text.
    let title = '', description = '', seo_meta = '';
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    const jsonStr = (s >= 0 && e > s) ? raw.slice(s, e + 1) : raw;
    let parsed = null;
    try { parsed = JSON.parse(jsonStr); }
    catch(_) {
      // The HTML description can occasionally arrive with literal line breaks that
      // break JSON.parse — collapse them and retry before giving up.
      try { parsed = JSON.parse(jsonStr.replace(/\r?\n/g, ' ')); } catch(__) {}
    }
    if (parsed) {
      title = (parsed.title || '').trim();
      description = (parsed.description || '').trim();
      seo_meta = (parsed.seo_meta || '').trim();
    } else { description = raw; }
    res.json({ success: true, title, description, seo_meta });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Clean up spelling/grammar ─────────────────────────────────
app.post('/cleanup-text', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: `Fix any spelling and grammar errors in the text below. Keep the same meaning, tone, and style. Use sentence case: capitalize only the first word of each sentence and proper nouns (names, places, brands). Do NOT use Title Case — do not capitalize every word. Return ONLY the corrected text with no explanation, no quotes, no preamble.\n\n${text}` }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    const cleaned = data.content && data.content[0] && data.content[0].text ? data.content[0].text.trim() : text;
    res.json({ text: cleaned });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Spell-check reference name ───────────────────────────────
app.post('/spellcheck-name', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured.' });
  const { text } = req.body;
  if (!text || !text.trim()) return res.json({ original: '', corrected: '', changed: false });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 100, messages: [{ role: 'user', content: `You are a spell-checker for handcrafted floral arrangement names. Fix any spelling errors in the name below. Preserve the original capitalization style and meaning exactly. Return ONLY the corrected name — no explanation, no quotes, no extra words. If there are no errors, return it unchanged.\n\nName: ${text.trim()}` }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    const corrected = data.content?.[0]?.text?.trim() || text.trim();
    res.json({ original: text.trim(), corrected, changed: corrected !== text.trim() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Parse receipt ─────────────────────────────────────────────
app.post('/parse-receipt', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });
  const { image_base64, mime_type, mode } = req.body;
  if (!image_base64) return res.status(400).json({ error: 'image_base64 is required' });
  const isMileage = mode === 'mileage';
  const isPdf = mime_type === 'application/pdf';

  const receiptPrompt = `You are reading a receipt image for a small business called Eternal Blooms Designs.
Extract the following information and return it as a JSON object with NO other text — no explanation, no markdown, just raw JSON.

Return exactly this structure:
{
  "vendor": "store or business name",
  "total": 0.00,
  "date": "YYYY-MM-DD",
  "description": "brief description of what was purchased",
  "payment_method": "Card" or "Cash" or "Venmo" or "Check" or "unknown",
  "suggested_category": one of: "Materials" or "Craft Show" or "Display" or "Tools" or "Business" or "Shipping" or "Other",
  "suggested_subcategory": one of these if category is Materials: "Flowers & stems" or "Ribbon & fabric" or "Containers & pots" or "Foam & structure" or "Wire & hardware" or "Rocks & fillers" or "Packaging" or "Other materials" — otherwise leave as ""
}

If you cannot read a value clearly, use null for numbers and "" for strings. If the date is unclear, use today's date in YYYY-MM-DD format.`;

  const mileagePrompt = `You are reading a handwritten mileage log or note for a small business called Eternal Blooms Designs.
Extract the trip information and return it as a JSON object with NO other text — no explanation, no markdown, just raw JSON.

Return exactly this structure:
{
  "description": "destination or trip description",
  "miles": 0,
  "date": "YYYY-MM-DD",
  "purpose": one of: "Craft show setup/breakdown" or "Client delivery" or "Materials pickup" or "Event/show day" or "Other business"
}

If multiple trips are visible, combine them into a total miles figure and summarize the description.
If you cannot read a value clearly, use null for numbers and "" for strings.`;

  let messageContent;
  if (isPdf) {
    messageContent = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: image_base64 } }, { type: 'text', text: isMileage ? mileagePrompt : receiptPrompt }];
  } else {
    const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const effectiveMime = validImageTypes.includes(mime_type) ? mime_type : 'image/jpeg';
    messageContent = [{ type: 'image', source: { type: 'base64', media_type: effectiveMime, data: image_base64 } }, { type: 'text', text: isMileage ? mileagePrompt : receiptPrompt }];
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 500, messages: [{ role: 'user', content: messageContent }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    const rawText = data.content && data.content[0] && data.content[0].text ? data.content[0].text.trim() : '{}';
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch(parseErr) { return res.status(422).json({ error: 'Could not parse receipt — try a clearer photo or enter manually.', raw: rawText }); }
    res.json(parsed);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
 
// ── Mark product as sold ──────────────────────────────────────
app.post('/mark-sold', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Not authorized — complete OAuth first.' });
  const { shopify_url, eb_number } = req.body;
  if (!shopify_url && !eb_number) return res.status(400).json({ error: 'shopify_url or eb_number required' });
  if (eb_number) mktHandleSoldSoon(String(eb_number).trim()); // background: pins for this piece
  try {
    let productId = null;
    if (eb_number) {
      const searchRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?fields=id,variants&limit=250`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
      const searchData = await searchRes.json();
      for (const p of (searchData.products||[])) {
        if (p.variants && p.variants.some(v => v.sku === eb_number)) { productId = p.id; break; }
      }
    }
    if (!productId) return res.json({ success: true, note: 'Product not found in Shopify — Airtable updated only' });
    const variantRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products/${productId}.json`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
    const variantData = await variantRes.json();
    const inventoryItemId = variantData.product?.variants?.[0]?.inventory_item_id;
    const locRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/locations.json`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
    const locData = await locRes.json();
    const locationId = locData.locations?.[0]?.id;
    if (locationId && inventoryItemId) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/inventory_levels/set.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId, available: 0 })
      });
    }
    const soldCollectionId = await getCollectionId('sold-portfolio');
    if (soldCollectionId) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/collects.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ collect: { product_id: productId, collection_id: soldCollectionId } })
      });
    }
    res.json({ success: true, product_id: productId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Sale & Clearance: apply or remove a storefront markdown ──────────────────
// Sets the Shopify variant to a discounted price while keeping the ORIGINAL price
// as compare-at (the strikethrough the theme renders + "Sale" badge), and tags the
// product `Sale` or `Clearance` so the tag-driven Sale/Clearance smart collections
// pick it up. action:'remove' restores the original price (compare-at cleared) and
// strips both tags. Airtable is the record of the markdown (Sale status / Sale
// price ($) / Markdown (%) / Sale date) and is written by the client; this route
// only touches Shopify. Idempotent — safe to re-run or re-price an item already on
// sale. A SKU that isn't on Shopify yet returns success so Airtable still records it.
app.post('/mark-sale', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Not authorized — complete OAuth first.' });
  const { eb_number, action, sale_type, sale_price, original_price } = req.body || {};
  if (!eb_number) return res.status(400).json({ error: 'eb_number required' });
  const act = action === 'remove' ? 'remove' : 'apply';
  if (act === 'apply') {
    const sp = Number(sale_price), op = Number(original_price);
    if (!Number.isFinite(sp) || sp <= 0) return res.status(400).json({ error: 'sale_price must be a positive number' });
    if (!Number.isFinite(op) || op <= 0) return res.status(400).json({ error: 'original_price must be a positive number' });
    if (sp >= op) return res.status(400).json({ error: 'sale_price must be below the original price' });
    if (sale_type !== 'Sale' && sale_type !== 'Clearance') return res.status(400).json({ error: "sale_type must be 'Sale' or 'Clearance'" });
  }
  try {
    // 1) Find the variant + product by EXACT SKU (variant search tokenizes on hyphens,
    //    so we trust equality only — same guard the publish path uses).
    const lookup = await shopifyGraphql(
      `query($q:String!){ productVariants(first:10, query:$q){ edges { node { id sku price compareAtPrice product { id legacyResourceId handle tags } } } } }`,
      { q: `sku:${JSON.stringify(String(eb_number))}` }
    );
    const edges = (((lookup || {}).data || {}).productVariants || {}).edges || [];
    const node = edges.map(e => e.node).find(n => n && n.sku === eb_number && n.product);
    if (!node) return res.json({ success: true, note: 'Product not found in Shopify — Airtable updated only' });

    const variantId = node.id;
    const productGid = node.product.id;
    const productId = Number(node.product.legacyResourceId);
    const handle = node.product.handle;

    // 2) Compute the new variant price + compare-at.
    let newPrice, newCompareAt, addTag = null;
    if (act === 'apply') {
      newPrice = Number(sale_price).toFixed(2);
      // Compare-at is the ORIGINAL full price. If the item is ALREADY on sale (compare-at
      // set), keep that existing anchor so re-pricing a sale doesn't lose the true original;
      // otherwise use the caller's original_price (the Airtable Price ($)).
      const anchor = (node.compareAtPrice != null && Number(node.compareAtPrice) > 0)
        ? Number(node.compareAtPrice) : Number(original_price);
      newCompareAt = anchor.toFixed(2);
      addTag = sale_type;
    } else {
      // Remove: restore full price = compare-at if present, else caller's original_price,
      // else the current live price. Compare-at cleared.
      const restore = (node.compareAtPrice != null && Number(node.compareAtPrice) > 0)
        ? Number(node.compareAtPrice)
        : (Number.isFinite(Number(original_price)) && Number(original_price) > 0 ? Number(original_price) : Number(node.price));
      newPrice = restore.toFixed(2);
      newCompareAt = null;
    }

    // 3) Update the variant price + compare-at.
    const upd = await shopifyGraphql(
      `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId: $productId, variants: $variants){ productVariants { id price compareAtPrice } userErrors { field message } } }`,
      { productId: productGid, variants: [{ id: variantId, price: newPrice, compareAtPrice: newCompareAt }] }
    );
    const vErr = (((upd || {}).data || {}).productVariantsBulkUpdate || {}).userErrors || (upd || {}).errors;
    if (vErr && vErr.length) return res.status(500).json({ error: 'Variant price update failed: ' + JSON.stringify(vErr) });

    // 4) Tags: keep exactly one of Sale/Clearance (or neither on remove). Remove first,
    //    then add, so switching Sale↔Clearance never leaves both tags on the product.
    const removeTags = ['Sale', 'Clearance'].filter(t => t !== addTag);
    if (removeTags.length) {
      await shopifyGraphql(`mutation($id: ID!, $tags: [String!]!){ tagsRemove(id: $id, tags: $tags){ userErrors { field message } } }`, { id: productGid, tags: removeTags });
    }
    if (addTag) {
      await shopifyGraphql(`mutation($id: ID!, $tags: [String!]!){ tagsAdd(id: $id, tags: $tags){ userErrors { field message } } }`, { id: productGid, tags: [addTag] });
    }

    res.json({ success: true, product_id: productId, handle, action: act, price: newPrice, compare_at_price: newCompareAt, tag: addTag });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Shopify webhook: orders/create → auto-mark ONLINE sales as Sold in Airtable ──
// Online orders sync automatically here, so the "Mark as sold" tile is reserved for
// in-person sales (Facebook Marketplace, craft fairs, outdoor planters, etc.) which
// never create a Shopify order. We verify Shopify's HMAC over the raw body before
// trusting anything, then look up each line item's SKU (EB Number) in Airtable and
// set Status=Sold / Sales channel=Shopify / Date sold. Shopify already decremented
// inventory to 0 on order creation, so we don't touch inventory here.
app.post('/webhooks/orders-create', async (req, res) => {
  // 1) Verify the webhook is genuinely from Shopify (signed with our app secret).
  const sentHmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET || '')
    .update(req.rawBody || Buffer.from(''))
    .digest('base64');
  let verified = false;
  try { verified = sentHmac.length > 0 && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sentHmac)); }
  catch { verified = false; }
  if (!verified) { console.warn('orders-create webhook: HMAC verification failed — rejecting'); return res.status(401).send('unauthorized'); }

  // 2) Process. Respond 200 on success; 500 on a transient Airtable error so Shopify
  //    retries. A SKU simply not found in Airtable is logged but NOT retried.
  const order = req.body || {};
  const orderRef = order.name || order.id || 'unknown';
  const dateSold = (order.created_at && String(order.created_at).slice(0, 10)) || undefined;
  const skus = [...new Set((order.line_items || [])
    .map(li => (li && li.sku ? String(li.sku).trim() : ''))
    .filter(s => /^EB-/i.test(s)))];

  if (!skus.length) { console.log(`orders-create ${orderRef}: no EB SKUs on order — nothing to sync`); return res.status(200).send('ok'); }

  let transientError = false, billingLimited = false;
  for (const sku of skus) {
    try {
      await invEnsure();
      const recs = invFindBySku(sku);
      if (!recs.length) { console.warn(`orders-create ${orderRef}: SKU ${sku} sold online but not found in Airtable — skipped`); continue; }
      if (recs.length > 1) console.warn(`orders-create ${orderRef}: SKU ${sku} matches ${recs.length} Airtable records — updating the first (${recs[0].id}); resolve the duplicate`);
      const fields = { 'Status': 'Sold', 'Sales channel': 'Shopify' };
      if (dateSold) fields['Date sold'] = dateSold;
      await airtableReq(`${AT_INVENTORY_TBL}/${recs[0].id}`, { method: 'PATCH', body: JSON.stringify({ fields, typecast: true }) });
      console.log(`orders-create ${orderRef}: marked ${sku} as Sold (Shopify) in Airtable`);
      mktHandleSoldSoon(sku); // background: skip unposted drafts, point live pins at similar pieces
    } catch (e) {
      transientError = true;
      if (isBillingLimitError(e)) billingLimited = true;
      console.warn(`orders-create ${orderRef}: failed to update ${sku} in Airtable — ${e.message}`);
    }
  }
  // Over the monthly API cap, Shopify's retries (8 over ~4 h) can't succeed and each one
  // is another rejected call — acknowledge instead; the sale must be marked by hand.
  if (billingLimited) { console.warn(`orders-create ${orderRef}: Airtable monthly API limit reached — NOT retrying; mark the sale as Sold manually`); return res.status(200).send('ok'); }
  if (transientError) return res.status(500).send('airtable error — retry');
  res.status(200).send('ok');
});

// ── Shopify webhook: products/update → mirror Sale/Clearance state into Airtable ──
// Closes the loop the other direction: a markdown made DIRECTLY in Shopify admin (set
// a compare-at price, and/or add a `Sale`/`Clearance` tag) gets tracked in Airtable
// too — not just markdowns made from the app's Sale & Clearance screen. We read the
// product's price/compare-at + tags, derive the sale state, and reconcile the four
// Airtable fields (Sale status / Sale price ($) / Markdown (%) / Sale date).
//   • Writes ONLY to Airtable, never back to Shopify → it cannot loop with /mark-sale.
//   • Fires on EVERY product edit, so we read the record first and PATCH only when the
//     sale state actually changed — which also preserves the original Sale date across
//     unrelated edits (title, photos, inventory, etc.).
//   • Tag wins for the type; a compare-at markdown with no tag defaults to Sale.
//   • read_products (already granted) is the only scope needed.
app.post('/webhooks/products-update', async (req, res) => {
  // 1) Verify the webhook is genuinely from Shopify (signed with our app secret).
  const sentHmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET || '')
    .update(req.rawBody || Buffer.from(''))
    .digest('base64');
  let verified = false;
  try { verified = sentHmac.length > 0 && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sentHmac)); }
  catch { verified = false; }
  if (!verified) { console.warn('products-update webhook: HMAC verification failed — rejecting'); return res.status(401).send('unauthorized'); }

  // 2) Derive the sale state from the product. One-of-a-kind pieces have a single
  //    EB-* variant; fall back to the first variant if the SKU isn't on that one.
  const product = req.body || {};
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const v = variants.find(x => x && /^EB-/i.test(String(x.sku || ''))) || variants[0] || {};
  const sku = String(v.sku || '').trim();
  if (!/^EB-/i.test(sku)) return res.status(200).send('ok'); // not an EB piece — ignore

  const price = Number(v.price);
  const compareAt = (v.compare_at_price != null && v.compare_at_price !== '') ? Number(v.compare_at_price) : null;
  const onMarkdown = compareAt != null && Number.isFinite(compareAt) && Number.isFinite(price) && compareAt > price;
  const tags = String(product.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const hasClearance = tags.includes('clearance');
  const hasSale = tags.includes('sale');
  const onSale = onMarkdown || hasSale || hasClearance;
  const type = hasClearance ? 'Clearance' : 'Sale'; // tag wins; markdown w/o tag defaults to Sale
  const desiredStatus = onSale ? type : 'None';
  const desiredSalePrice = (onSale && Number.isFinite(price)) ? Number(price.toFixed(2)) : null;
  const desiredPctInt = onSale ? (onMarkdown ? Math.round((compareAt - price) / compareAt * 100) : 0) : null;
  // Can't determine a sale price (bad/blank price on a supposedly-on-sale item) — don't guess.
  if (onSale && desiredSalePrice == null) { console.warn(`products-update: SKU ${sku} looks on sale but has no usable price — skipped`); return res.status(200).send('ok'); }

  // 3) Reconcile into Airtable, but only when the sale state actually changed. The
  //    comparison uses the server's inventory cache, so the usual case (nothing changed
  //    — a photo, inventory, metafield or publish update) costs no Airtable call at all.
  try {
    await invEnsure();
    const recs = invFindBySku(sku);
    if (!recs.length) { console.log(`products-update: SKU ${sku} not in Airtable — skipped`); return res.status(200).send('ok'); }
    if (recs.length > 1) console.warn(`products-update: SKU ${sku} matches ${recs.length} Airtable records — updating the first (${recs[0].id}); resolve the duplicate`);
    const rec = recs[0];
    const f = rec.fields || {};
    const curStatus = f['Sale status'] || 'None';
    const curSalePrice = (f['Sale price ($)'] != null) ? Number(f['Sale price ($)']) : null;
    const curPctInt = (f['Markdown (%)'] != null) ? Math.round(Number(f['Markdown (%)']) * 100) : null;

    const statusChanged = curStatus !== desiredStatus;
    const priceChanged = onSale && (curSalePrice == null || Number(curSalePrice.toFixed(2)) !== desiredSalePrice);
    const pctChanged = onSale && (curPctInt !== desiredPctInt);
    if (!statusChanged && !priceChanged && !pctChanged) return res.status(200).send('ok'); // already in sync

    const fields = { 'Sale status': desiredStatus };
    if (onSale) {
      fields['Sale price ($)'] = desiredSalePrice;
      fields['Markdown (%)'] = desiredPctInt / 100;
      // Stamp Sale date only when the piece NEWLY enters a sale (or has none yet);
      // keep the original date when it was already on sale and just got re-priced.
      const wasOnSale = curStatus === 'Sale' || curStatus === 'Clearance';
      if (!wasOnSale || f['Sale date'] == null) fields['Sale date'] = new Date().toISOString().split('T')[0];
    } else {
      fields['Sale price ($)'] = null;
      fields['Markdown (%)'] = null;
      fields['Sale date'] = null;
    }
    await airtableReq(`${AT_INVENTORY_TBL}/${rec.id}`, { method: 'PATCH', body: JSON.stringify({ fields, typecast: true }) });
    console.log(`products-update: SKU ${sku} → Sale status ${desiredStatus}${onSale ? ` @ $${desiredSalePrice} (${desiredPctInt}% off)` : ''} (synced from Shopify)`);
    res.status(200).send('ok');
  } catch (e) {
    console.warn(`products-update: failed to reconcile ${sku} — ${e.message}`);
    // Over the monthly API cap a retry can't succeed (it would just be another rejected
    // call) — acknowledge; the sale state re-syncs on the product's next update.
    if (isBillingLimitError(e)) return res.status(200).send('ok');
    return res.status(500).send('airtable error — retry');
  }
});

// ── Make an existing listing local-only (backfill / fix) ──────────────────────
// POST { sku }. Converts a live product to local-only, the same as publishing it fresh:
// LOCAL delivery profile, requires_shipping back ON (so checkout offers pickup / local
// delivery instead of skipping delivery), the local-only notice at the top of the description,
// and the local-only tag. Idempotent — safe to run again on a piece that's already converted.
app.post('/apply-local-only', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify is not connected on the server yet — open /auth once to connect.' });
  const sku = String((req.body || {}).sku || '').trim();
  if (!sku) return res.status(400).json({ error: 'sku is required' });
  if (!(await getLocalOnlyProfileGid())) return res.status(400).json({ error: 'No LOCAL row in the Airtable "Shipping Profile Map" table — create the "Local only" delivery profile in Shopify and add its GID there first.' });
  try {
    const look = await shopifyGraphql(`query($q:String!){ productVariants(first:10, query:$q){ nodes { id sku inventoryItem { id } product { id descriptionHtml } } } }`, { q: `sku:${JSON.stringify(sku)}` });
    // Exact match only — variant search tokenizes on hyphens.
    const v = (look?.data?.productVariants?.nodes || []).find(n => n && n.sku === sku);
    if (!v) return res.status(404).json({ error: `No Shopify variant with SKU ${sku}` });
    const steps = {};
    // Profile first, then flip requires_shipping on — so the variant is never shippable on General.
    if (!(await assignShippingProfile(sku, v.id, null, true))) {
      return res.status(502).json({ success: false, sku, error: 'Could not assign the LOCAL delivery profile (see server log) — nothing else was changed.' });
    }
    steps.profile = 'LOCAL';
    const inv = await shopifyGraphql(`mutation($id:ID!,$input:InventoryItemInput!){ inventoryItemUpdate(id:$id, input:$input){ userErrors { message } } }`, { id: v.inventoryItem.id, input: { requiresShipping: true } });
    const invErrs = inv?.errors || inv?.data?.inventoryItemUpdate?.userErrors || [];
    steps.requiresShipping = invErrs.length ? 'failed: ' + invErrs.map(e => e.message).join(', ') : 'true';
    const html = v.product.descriptionHtml || '';
    if (html.includes('eb-local-only')) steps.notice = 'already present';
    else {
      const pu = await shopifyGraphql(`mutation($product:ProductUpdateInput!){ productUpdate(product:$product){ userErrors { message } } }`, { product: { id: v.product.id, descriptionHtml: withLocalOnlyNotice(html) } });
      const puErrs = pu?.errors || pu?.data?.productUpdate?.userErrors || [];
      steps.notice = puErrs.length ? 'failed: ' + puErrs.map(e => e.message).join(', ') : 'added';
    }
    const tg = await shopifyGraphql(`mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors { message } } }`, { id: v.product.id, tags: [LOCAL_ONLY_TAG] });
    const tgErrs = tg?.errors || tg?.data?.tagsAdd?.userErrors || [];
    steps.tag = tgErrs.length ? 'failed: ' + tgErrs.map(e => e.message).join(', ') : 'added';
    steps.salesChannels = await setExtraSalesChannels(v.product.id, sku, false);
    const ok =!Object.values(steps).some(s => String(s).startsWith('failed'));
    console.log(`apply-local-only ${sku}:`, JSON.stringify(steps));
    res.status(ok ? 200 : 207).json({ success: ok, sku, steps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Order fulfillment: open Shopify orders → packing reference ────────────────
// Pulls OPEN + UNFULFILLED orders straight from Shopify and joins each line item
// to its Airtable record so the app can show a quick PACKING REFERENCE: the real
// item weight, the actual product dimensions, and the "Normal Shipping" box size.
// PirateShip's own Shopify app imports the orders — so this is NOT a CSV export;
// it's the bench reference the Shopify order can't give, because the Shopify
// weight field carries our DIM-lb shipping-tier value, not the true weight.
// Read-only. Missing fields are returned WITH per-item warnings, never dropped.
app.get('/orders/open', async (req, res) => {
  if (!shopifyAccessToken) return res.status(400).json({ error: 'Shopify is not connected on the server yet — open /auth once to connect.' });
  try {
    // 1) Fetch open, unfulfilled orders from Shopify (most recent first).
    const fields = 'id,name,email,created_at,cancelled_at,fulfillment_status,shipping_address,line_items';
    const url = `https://${SHOPIFY_STORE}/admin/api/2026-04/orders.json?status=open&fulfillment_status=unshipped&limit=250&fields=${encodeURIComponent(fields)}`;
    const oRes = await fetch(url, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
    if (!oRes.ok) {
      const body = await oRes.text().catch(() => '');
      const hint = (oRes.status === 401 || oRes.status === 403)
        ? ' — the read_orders scope may be missing; reconnect Shopify via /auth.' : '';
      return res.status(oRes.status).json({ error: `Shopify orders fetch failed (${oRes.status})${hint}`, detail: body.slice(0, 300) });
    }
    const oData = await oRes.json();
    const orders = (oData.orders || []).filter(o => !o.cancelled_at);

    // 2) Collect unique SKUs across all orders and look up shipping data from
    //    Airtable (batched OR-filter queries, capped so the formula stays short).
    //    Match ANY non-empty SKU against Airtable's EB Number — not just EB-*
    //    prefixed ones — so test SKUs (e.g. TEST-T1) and any future naming still
    //    join. Unmatched SKUs are reported per-item as "not found", not skipped.
    const skuSet = new Set();
    for (const o of orders) for (const li of (o.line_items || [])) {
      const s = (li.sku || '').trim();
      if (s) skuSet.add(s);
    }
    const WANT = ['EB Number', 'Reference name', 'Normal Shipping', 'Item weight (oz)', 'Width (in)', 'Height (in)', 'Depth (in)', 'Type', 'Delivery option'];
    const shipBySku = {};
    if (skuSet.size) {
      await invEnsure();
      for (const r of invRecords()) {
        const f = r.fields || {}, eb = String(f['EB Number'] || '').trim();
        if (eb && skuSet.has(eb)) shipBySku[eb] = Object.fromEntries(WANT.map(k => [k, f[k]]).filter(([, v]) => v !== undefined));
      }
    }

    // 3) Shape each order + line item as a packing reference: real item weight
    //    (oz, plus a lb convenience value), the actual product dimensions, and the
    //    "Normal Shipping" box size. Missing fields become warnings, not blockers.
    const num = (v) => (v != null && v !== '' && !isNaN(Number(v))) ? Number(v) : null;
    const out = orders.map(o => {
      const sa = o.shipping_address || {};
      const orderWarnings = [];
      // Local-only line items are KEPT (they used to be filtered out with requires_shipping:false,
      // which hid order #1002 from this list) and flagged so they're never boxed and shipped.
      const items = (o.line_items || [])
        .map(li => {
          const sku = (li.sku || '').trim();
          const rec = shipBySku[sku];
          const warnings = [];
          const localOnly = li.requires_shipping === false || (!!rec && isLocalOnlyRecord(rec));
          let normalShipping = null, itemWeightOz = null, pounds = null, actualDims = null;
          if (!sku) {
            warnings.push('Line item has no SKU — add one in Shopify so it can match Airtable');
          } else if (!rec) {
            warnings.push(`SKU ${sku} not found in Airtable`);
          } else {
            normalShipping = rec['Normal Shipping'] || null;
            if (!normalShipping) warnings.push("No 'Normal Shipping' box size in Airtable");
            itemWeightOz = num(rec['Item weight (oz)']);
            if (itemWeightOz != null && itemWeightOz > 0) pounds = Math.round((itemWeightOz / 16) * 10) / 10;
            else warnings.push('No item weight in Airtable');
            const w = num(rec['Width (in)']), h = num(rec['Height (in)']), d = num(rec['Depth (in)']);
            if (w != null || h != null || d != null) actualDims = { width: w, height: h, depth: d };
            else warnings.push('No actual dimensions in Airtable');
          }
          return {
            sku, title: li.name || li.title || '', quantity: li.quantity || 1,
            reference: rec ? (rec['Reference name'] || null) : null,
            itemWeightOz, pounds, actualDims, normalShipping,
            found: !!rec, localOnly, warnings
          };
        });
      const localCount = items.filter(it => it.localOnly).length;
      if (localCount) orderWarnings.push(`LOCAL ONLY — do not ship. Arrange pickup or local delivery with the buyer${o.shipping_address ? ' (this order has a ship-to address — confirm they can pick up, or refund)' : ''}.`);
      if (!o.shipping_address && localCount < items.length) orderWarnings.push('No shipping address on this order');
      return {
        orderId: o.name || String(o.id),
        createdAt: o.created_at || null,
        email: o.email || '',
        ship: {
          name: sa.name || [sa.first_name, sa.last_name].filter(Boolean).join(' '),
          company: sa.company || '',
          address1: sa.address1 || '',
          address2: sa.address2 || '',
          city: sa.city || '',
          province: sa.province_code || sa.province || '',
          zip: sa.zip || '',
          country: sa.country_code || sa.country || '',
          phone: sa.phone || ''
        },
        multiItem: items.length > 1,
        localOnly: localCount > 0,
        items,
        warnings: orderWarnings
      };
    });
    res.json({ ok: true, count: out.length, orders: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Version / health (verify what's actually deployed) ────────
app.get('/version', (req, res) => res.json({ version: '2026-07-03-fixpack9', features: ['create-product idempotent by SKU (returns existing product instead of duplicating on retry/timeout)','drive-move-folder: publish→Published, sold→Sold (idempotent bucket move)','custom metaobjects for collapsed decoration/planter values (Grapevine/Pine/Candle/Lights/Galvanized Steel/Basket)', 'wreath material reuse-by-taxonomy-reference', 'plant-name + season + suitable-space on wreaths', 'inventory-set: @idempotent+changeFromQuantity (2026-04 fix)', 'wreath category fix', 'lighting GID swap fixed', 'resync-attributes(add-only+inventory)', 'plant-material=Artificial', 'care_instructions->custom.care_instructions', 'indoor_outdoor->custom.indoor_outdoor (universal multi-select; wreaths also get native suitable-space)', 'suggested_display->custom.suggested_display (multi-select surface/spot)', 'mark-sale: Sale/Clearance markdown (compare-at strikethrough + Sale/Clearance tag → tag-driven collections), apply/remove', 'webhooks/products-update: mirror Sale/Clearance markdowns made directly in Shopify back into Airtable (change-only reconcile)', 'local-only pieces: LOCAL delivery profile + requires_shipping kept on + auto notice/tag; /apply-local-only backfill; local-only items shown in /orders/open'] }));

// Resolve the tool-owned taxonomy metafield GIDs for a product, category-gated.
// Shared by /create-product (replace) and /resync-attributes (merge) so the value→GID
// wiring lives in one place. Returns per-key GID lists + the set of keys valid for the
// category (color-pattern is universal). Unmapped values are dropped.
function buildToolMetafieldGids(product_category, body){
  const { colors, pattern, plant_name, locations, arrangement, plant_container_type, stem_length, decoration_material, planter_material, celebration_type, lighting_options, shape, season, suitable_space } = body;
  const mapGids = (vals, map) => (Array.isArray(vals) ? vals : (vals ? [vals] : [])).map(v => map[v]).filter(Boolean);
  const colorGids = mapGids(colors, SHOPIFY_COLOR_METAOBJECTS);
  const patternGids = mapGids(pattern, SHOPIFY_PATTERN_METAOBJECTS);
  const perKey = {
    'color-pattern':        colorGids.concat(patternGids),
    'plant-name':           mapGids(plant_name, SHOPIFY_PLANT_METAOBJECTS),
    'suitable-location':    mapGids(locations, SHOPIFY_LOCATION_METAOBJECTS),
    'arrangement':          mapGids(arrangement, SHOPIFY_ARRANGEMENT_METAOBJECTS),
    'plant-container-type': mapGids(plant_container_type, SHOPIFY_CONTAINER_METAOBJECTS),
    'stem-length':          mapGids(stem_length, SHOPIFY_STEM_METAOBJECTS),
    'decoration-material':  mapGids(decoration_material, SHOPIFY_DECORATION_MATERIAL_METAOBJECTS),
    'planter-material':     mapGids(planter_material, SHOPIFY_PLANTER_MATERIAL_METAOBJECTS),
    'celebration-type':     mapGids(celebration_type, SHOPIFY_CELEBRATION_METAOBJECTS),
    'lighting-options':     mapGids(lighting_options, SHOPIFY_LIGHTING_METAOBJECTS),
    'shape':                mapGids(shape, SHOPIFY_SHAPE_METAOBJECTS),
    'season':               mapGids(season, SHOPIFY_SEASON_METAOBJECTS),
    'suitable-space':       mapSuitableSpace(suitable_space)
  };
  const allowed = new Set(['color-pattern'].concat(CATEGORY_METAFIELD_KEYS[product_category] || []));
  return { categoryGid: SHOPIFY_CATEGORY_GIDS[product_category], colorGids, patternGids, perKey, allowed };
}

// ── Create product ────────────────────────────────────────────
app.post('/create-product', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Not authorized. Visit ' + SERVER_URL + '/auth to complete Shopify OAuth first.' });
  const { title, body_html, sku, price, tags, product_type, collections, ship_weight_lb, dimensions, meta_description, requires_shipping, local_only, images, quantity, product_category, colors, pattern, plant_name, locations, arrangement, plant_container_type, stem_length, decoration_material, planter_material, celebration_type, lighting_options, shape, care_instructions, indoor_outdoor, suggested_display } = req.body;
  if (!title || !sku) return res.status(400).json({ error: 'title and sku are required' });
  // Older clients (listing.html) signal local-only with requires_shipping:false.
  const localOnly = local_only === true || requires_shipping === false;
  // A local-only piece MUST land in the no-rates LOCAL profile. Without it, the only
  // alternatives are a carrier-rate profile (ships nationally) or requires_shipping:false
  // (ships free, anywhere) — both wrong — so refuse the publish instead of listing it badly.
  if (localOnly && !(await getLocalOnlyProfileGid())) {
    return res.status(400).json({ error: `${sku} is local-only, but no LOCAL row is set in the Airtable "Shipping Profile Map" table. Create the "Local only" delivery profile in Shopify (no shipping rates; local pickup/delivery on), add its GID to that table with Tier = LOCAL, then publish again.` });
  }

  // ── Idempotency guard: never create a second product for a SKU that already exists ──
  // Publishing isn't atomic and the client aborts slow requests, so a retry (or a
  // slow-but-successful publish the client treated as a failure) previously created a
  // DUPLICATE product with the same SKU — triggering Shopify's "SKU used by another item"
  // warning. If the SKU is already live, return that product instead of creating another.
  // A lookup failure is non-fatal: we log and fall through to normal creation.
  try {
    const lookupRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($q:String!){ productVariants(first:10, query:$q){ edges { node { sku product { legacyResourceId handle featuredImage { url } } } } } }`,
        variables: { q: `sku:${JSON.stringify(String(sku))}` }
      })
    });
    const lookupData = await lookupRes.json();
    const edges = (lookupData && lookupData.data && lookupData.data.productVariants && lookupData.data.productVariants.edges) || [];
    // Require an EXACT sku match (variant search tokenizes on hyphens, so trust equality only).
    const hit = edges.map(e => e.node).find(n => n && n.sku === sku && n.product);
    if (hit) {
      const p = hit.product;
      console.log(`create-product: SKU ${sku} already exists (product ${p.legacyResourceId}) — returning existing, not duplicating.`);
      return res.json({
        success: true,
        already_existed: true,
        product_id: Number(p.legacyResourceId),
        handle: p.handle,
        shopify_url: `https://eternalbloomsbypatti.com/products/${p.handle}`,
        admin_url: `https://admin.shopify.com/store/zdzva0-tj/products/${p.legacyResourceId}`,
        hero_image_url: p.featuredImage ? p.featuredImage.url : null,
        note: 'A product with this SKU already exists — returned it instead of creating a duplicate. Use Re-sync to update its attributes.'
      });
    }
  } catch (e) {
    console.warn('create-product SKU idempotency lookup failed (proceeding to create):', e.message);
  }

  // Inventory quantity — default to 1 (one-of-a-kind) when unset; clamp to a non-negative integer.
  const qty = (quantity != null && quantity !== '' && Number.isFinite(Number(quantity))) ? Math.max(0, Math.round(Number(quantity))) : 1;
  const variant = { sku, price: price || '0.00', inventory_management: 'shopify', inventory_policy: 'deny', fulfillment_service: 'manual', requires_shipping: true };
  // Weight is a SYNTHETIC shipping-tier key, NOT a physical weight. It carries the Airtable
  // "Shopify Ship Weight (lb)" formula (field fldQvj1c5tZBVDRAe) — always one of 5 / 15 / 28 / 45 lb —
  // which snaps each piece to the mid-band weight of its flat-rate shipping tier. The tier is
  // derived upstream from Effective Net Charge (wreaths tie out box → UPS rate → charge → tier).
  // Shopify flat-rate shipping can only condition on order weight, so we encode the tier here.
  // Blank means the piece has no shipping estimate yet — DON'T write a weight (leave Shopify's
  // default untouched) and warn with the SKU; the piece shouldn't go live until it's fixed.
  if (ship_weight_lb != null && ship_weight_lb !== '' && Number.isFinite(Number(ship_weight_lb))) {
    variant.weight = Number(ship_weight_lb);
    variant.weight_unit = 'lb';
  } else {
    console.warn(`create-product: SKU ${sku} has no Shopify Ship Weight (lb) — variant weight left unset (piece needs a shipping estimate before it goes live).`);
  }
  // Local-only notice is added here (not left to the description writer) so it can't be skipped.
  let fullDescription = localOnly ? withLocalOnlyNotice(body_html) : (body_html || '');
  if (dimensions) {
    fullDescription += '<p><strong>Dimensions:</strong> ' + dimensions + '</p>';
    fullDescription += '<p><em>Product dimensions are measured from tip to tip of leaves or flowers.</em></p>';
  }
  const productPayload = {
    product: {
      title, body_html: fullDescription, vendor: 'Eternal Blooms Designs', product_type: product_type || '', tags: localOnly ? withLocalOnlyTag(tags) : (tags || ''),
      variants: [variant],
      images: (images || []).map((img, i) => ({ attachment: img.data, filename: img.filename, position: i + 1 }))
    }
  };
  if (meta_description) productPayload.product.metafields_global_description_tag = meta_description;
  try {
    const r = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(productPayload)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.errors || 'Shopify error' });
    const productId = data.product.id;
    const inventoryItemId = data.product.variants[0].inventory_item_id;
    const variantRestId = data.product.variants[0].id;
    const locRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/locations.json`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
    const locData = await locRes.json();
    const locationId = locData.locations && locData.locations[0] && locData.locations[0].id;
    if (locationId) {
      // Connect the inventory item to the location first. set.json fails on an
      // unconnected item, which is why new products were landing at 0 available.
      // An already-connected item returns 422 — safe to ignore.
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/inventory_levels/connect.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, inventory_item_id: inventoryItemId })
      }).catch(() => {});
      // Set available quantity via GraphQL — REST inventory_levels/set.json is
      // deprecated in 2026-04 and silently no-ops, leaving products at 0. The
      // connect above ensures the level exists at the location.
      // 2026-04 made TWO breaking changes to inventorySetQuantities (both required,
      // both were missing — which is why inventory kept landing at 0 even after #28
      // removed ignoreCompareQuantity):
      //   1. The @idempotent(key:…) directive is now MANDATORY (idempotency key).
      //   2. Each quantity must carry `changeFromQuantity`; it isn't flagged required
      //      in the schema but the mutation errors at RUNTIME without it. Pass null to
      //      opt out of the compare-and-swap check (correct here — we're the source of
      //      truth for a brand-new product).
      try {
        const invMutation = `mutation invSet($input:InventorySetQuantitiesInput!,$idem:String!){inventorySetQuantities(input:$input)@idempotent(key:$idem){userErrors{code field message}}}`;
        const invInput = {
          name: 'available', reason: 'correction',
          quantities: [{ inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`, locationId: `gid://shopify/Location/${locationId}`, quantity: qty, changeFromQuantity: null }]
        };
        const invData = await shopifyGraphql(invMutation, { input: invInput, idem: crypto.randomUUID() });
        if (invData?.errors) console.warn('Inventory set GraphQL error:', JSON.stringify(invData.errors));
        const invErrs = invData?.data?.inventorySetQuantities?.userErrors || [];
        if (invErrs.length) console.warn('Inventory set failed:', invErrs.map(e => e.message).join(', '));
        if (!invData?.errors && !invErrs.length) console.log('Inventory set ok:', sku, '→', qty);
      } catch (invErr) { console.warn('Inventory set error (non-fatal):', invErr.message); }
    }
    // Assign the variant to its weight-tier delivery profile so multi-box carts price
    // additively (rates from different profiles SUM at checkout). Non-fatal + idempotent;
    // local-only pieces go to the no-rates LOCAL profile (pickup / local delivery only).
    const profileOk = await assignShippingProfile(sku, `gid://shopify/ProductVariant/${variantRestId}`, ship_weight_lb, localOnly);
    // A local-only piece that missed the LOCAL profile would sit on General and quote carrier
    // rates nationwide — pull it back to draft so it can't sell until it's fixed.
    let localOnlyWarning = null;
    if (localOnly && !profileOk) {
      localOnlyWarning = 'Local-only profile could not be assigned — listing set to DRAFT so it cannot be bought with shipping. Fix the LOCAL row in Shipping Profile Map, then run /apply-local-only and re-activate.';
      try { await shopifyGraphql(`mutation($product:ProductUpdateInput!){ productUpdate(product:$product){ userErrors { message } } }`, { product: { id: `gid://shopify/Product/${productId}`, status: 'DRAFT' } }); }
      catch (e) { console.warn('local-only draft fallback failed:', e.message); }
      console.warn(`create-product: ${sku} ${localOnlyWarning}`);
    }
    // Google & YouTube, Facebook & Instagram and Shop — shippable pieces only.
    const salesChannels = localOnly ? 'skipped (local-only)' : await setExtraSalesChannels(`gid://shopify/Product/${productId}`, sku, true);
    // Set the Shopify standard product category (taxonomy) AND the native
    // "Color" attribute (shopify.color-pattern) — REST can set neither, so use a
    // productUpdate GraphQL mutation. Category is skipped for Add-ons (no mapping).
    // Colors map to color-pattern metaobjects (exact EB shade label + nearest
    // standard-color taxonomy ref); unknown color names are dropped. Non-fatal.
    // Resolve tool-owned taxonomy GIDs (category-gated) via the shared builder, then
    // REPLACE each valid metafield's value (new product → nothing to merge with).
    const { categoryGid, colorGids, patternGids, perKey, allowed } = buildToolMetafieldGids(product_category, req.body);
    const mf = [];
    for (const key of Object.keys(perKey)) {
      if (allowed.has(key) && perKey[key].length) mf.push({ namespace: 'shopify', key, type: 'list.metaobject_reference', value: JSON.stringify(perKey[key]) });
    }
    if (categoryGid || mf.length) {
      try {
        const productInput = { id: `gid://shopify/Product/${productId}` };
        if (categoryGid) productInput.category = categoryGid;
        if (mf.length) productInput.metafields = mf;
        const upMutation = `mutation productUpdate($product:ProductUpdateInput!){productUpdate(product:$product){product{id category{id name}}userErrors{field message}}}`;
        const upData = await shopifyGraphql(upMutation, { product: productInput });
        const upErrors = upData?.data?.productUpdate?.userErrors || [];
        if (upErrors.length) console.warn('Category/metafield update userErrors:', upErrors.map(e => e.message).join(', '));
        else console.log('Metafields set:', sku, '→', mf.map(m => m.key).join(', ') || '(none)', categoryGid ? '+ category' : '');
      } catch (upErr) { console.warn('Category/metafield update failed (non-fatal):', upErr.message); }
    }
    // Plant material is always "Artificial" for every categorised product (skip
    // Add-ons, which have no category). Separate productUpdate + own try/catch so a
    // category that doesn't accept this attribute can't drop the metafields above.
    if (categoryGid) {
      try {
        const pmMutation = `mutation productUpdate($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{field message}}}`;
        const pmData = await shopifyGraphql(pmMutation, { product: { id: `gid://shopify/Product/${productId}`, metafields: [{ namespace: 'shopify', key: 'plant-material', type: 'list.metaobject_reference', value: JSON.stringify([SHOPIFY_PLANT_MATERIAL_ARTIFICIAL]) }] } });
        const pmErrs = pmData?.data?.productUpdate?.userErrors || [];
        if (pmErrs.length) console.warn('plant-material (Artificial) not set:', pmErrs.map(e => e.message).join(', '));
        else console.log('plant-material set: Artificial →', sku);
      } catch (pmErr) { console.warn('plant-material update failed (non-fatal):', pmErr.message); }
    }
    // Wreaths: set shopify.material = Synthetic + the chosen Decoration/Planter materials
    // crosswalked to Material metaobjects (Wreaths has no decoration/planter attributes).
    // Own update (Material is a Wreaths attribute; not valid for AFP, so gate + isolate it).
    if (product_category === 'Wreaths') {
      try {
        const matGids = await resolveWreathMaterialGids(req.body);
        const matMutation = `mutation productUpdate($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{field message}}}`;
        const matData = await shopifyGraphql(matMutation, { product: { id: `gid://shopify/Product/${productId}`, metafields: [{ namespace: 'shopify', key: 'material', type: 'list.metaobject_reference', value: JSON.stringify(matGids) }] } });
        const matErrs = matData?.data?.productUpdate?.userErrors || [];
        if (matErrs.length) console.warn('material not set:', matErrs.map(e => e.message).join(', '));
        else console.log('material set:', sku, '→', matGids.length, 'value(s)');
      } catch (matErr) { console.warn('material update failed (non-fatal):', matErr.message); }
    }
    // Care instructions → custom.care_instructions (list.single_line_text_field). Tool-owned
    // free-from-Airtable text list; own update + try/catch so it can't drop the rest. Non-fatal.
    {
      const careList = (Array.isArray(care_instructions) ? care_instructions : (care_instructions ? [care_instructions] : [])).filter(Boolean);
      if (careList.length) {
        try {
          const ciData = await shopifyGraphql(`mutation productUpdate($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{field message}}}`, { product: { id: `gid://shopify/Product/${productId}`, metafields: [{ namespace: 'custom', key: 'care_instructions', type: 'list.single_line_text_field', value: JSON.stringify(careList) }] } });
          const ciErrs = ciData?.data?.productUpdate?.userErrors || [];
          if (ciErrs.length) console.warn('care_instructions not set:', ciErrs.map(e => e.message).join(', '));
          else console.log('care_instructions set:', sku, '→', careList.length, 'item(s)');
        } catch (ciErr) { console.warn('care_instructions update failed (non-fatal):', ciErr.message); }
      }
    }
    // Indoor/Outdoor → custom.indoor_outdoor (multi-select). Universal across categories
    // (wreaths also get native shopify.suitable-space). Own update + try/catch; non-fatal.
    {
      const ioList = mapIndoorOutdoorList(indoor_outdoor);
      if (ioList.length) {
        try {
          const ioData = await shopifyGraphql(`mutation productUpdate($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{field message}}}`, { product: { id: `gid://shopify/Product/${productId}`, metafields: [{ namespace: 'custom', key: 'indoor_outdoor', type: 'list.single_line_text_field', value: JSON.stringify(ioList) }] } });
          const ioErrs = ioData?.data?.productUpdate?.userErrors || [];
          if (ioErrs.length) console.warn('indoor_outdoor not set:', ioErrs.map(e => e.message).join(', '));
          else console.log('indoor_outdoor set:', sku, '→', ioList.join('+'));
        } catch (ioErr) { console.warn('indoor_outdoor update failed (non-fatal):', ioErr.message); }
      }
    }
    // Suggested display → custom.suggested_display (multi-select). Tool-owned list; own
    // update + try/catch; non-fatal.
    {
      const sdList = (Array.isArray(suggested_display) ? suggested_display : (suggested_display ? [suggested_display] : [])).filter(Boolean);
      if (sdList.length) {
        try {
          const sdData = await shopifyGraphql(`mutation productUpdate($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{field message}}}`, { product: { id: `gid://shopify/Product/${productId}`, metafields: [{ namespace: 'custom', key: 'suggested_display', type: 'list.single_line_text_field', value: JSON.stringify(sdList) }] } });
          const sdErrs = sdData?.data?.productUpdate?.userErrors || [];
          if (sdErrs.length) console.warn('suggested_display not set:', sdErrs.map(e => e.message).join(', '));
          else console.log('suggested_display set:', sku, '→', sdList.length, 'item(s)');
        } catch (sdErr) { console.warn('suggested_display update failed (non-fatal):', sdErr.message); }
      }
    }
    const collectionHandles = Array.isArray(collections) ? collections : [];
    const collectionResults = [];
    for (const handle of collectionHandles) {
      try {
        const collectionId = await getCollectionId(handle);
        if (!collectionId) { collectionResults.push({ handle, status: 'not found' }); continue; }
        const collectRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/collects.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ collect: { product_id: productId, collection_id: collectionId } })
        });
        const collectData = await collectRes.json();
        collectionResults.push({ handle, status: collectRes.ok ? 'assigned' : 'error', detail: collectData.errors });
      } catch(e) { collectionResults.push({ handle, status: 'error', detail: e.message }); }
    }
    const productUrl = `https://eternalbloomsbypatti.com/products/${data.product.handle}`;
    const heroImageUrl = data.product.images && data.product.images.length > 0 ? data.product.images[0].src : null;
    const metafieldsSet = mf.reduce((acc, m) => { acc[m.key] = JSON.parse(m.value).length; return acc; }, {});
    res.json({ success: true, product_id: productId, handle: data.product.handle, shopify_url: productUrl, admin_url: `https://admin.shopify.com/store/zdzva0-tj/products/${productId}`, hero_image_url: heroImageUrl, collections_assigned: collectionResults, quantity: qty, category: (categoryGid ? product_category : null), colors_set: colorGids.length, pattern_set: patternGids.length, metafields_set: metafieldsSet, local_only: localOnly, sales_channels: salesChannels, ...(localOnlyWarning ? { warning: localOnlyWarning } : {}) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Re-sync attributes & inventory to an EXISTING product ─────
// Re-applies tool-owned structured data to an already-published product (matched by
// SKU) WITHOUT recreating it. ADD-ONLY/merge for taxonomy metafields: unions the tool's
// GIDs with whatever is already on the product, so values added in Shopify are KEPT and
// nothing is removed. Resets inventory to the tool Quantity (revisit once Airtable is a
// bidirectional source of truth). NEVER touches title/body/images/price/tags.
app.post('/resync-attributes', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Not authorized — visit /auth' });
  const { sku, quantity, product_category, care_instructions, indoor_outdoor, suggested_display } = req.body;
  if (!sku) return res.status(400).json({ error: 'sku required' });
  try {
    // 1. Find product + variant + current shopify-namespace metafields by SKU
    const lookup = await shopifyGraphql(`query($q:String!){productVariants(first:1,query:$q){edges{node{id sku inventoryItem{id} product{id metafields(first:50,namespace:"shopify"){edges{node{key value}}}}}}}}`, { q: `sku:${sku}` });
    const node = lookup?.data?.productVariants?.edges?.[0]?.node;
    if (!node) return res.status(404).json({ error: 'No Shopify product found for SKU ' + sku });
    const productId = node.product.id;                 // already a GID
    const inventoryItemId = node.inventoryItem && node.inventoryItem.id;
    const current = {};
    (node.product.metafields && node.product.metafields.edges || []).forEach(e => { current[e.node.key] = e.node.value; });
    const curList = (key) => { try { return current[key] ? JSON.parse(current[key]) : []; } catch(_) { return []; } };

    // 2. Build tool GIDs (category-gated) and MERGE (union) with current — never remove
    const { categoryGid, perKey, allowed } = buildToolMetafieldGids(product_category, req.body);
    const mf = [];
    const added = {};
    const unionInto = (key, toolGids) => {
      const union = curList(key).slice();
      let n = 0;
      toolGids.forEach(g => { if (!union.includes(g)) { union.push(g); n++; } });
      if (n > 0) { mf.push({ namespace: 'shopify', key, type: 'list.metaobject_reference', value: JSON.stringify(union) }); added[key] = n; }
    };
    for (const key of Object.keys(perKey)) { if (allowed.has(key) && perKey[key].length) unionInto(key, perKey[key]); }
    // Auto-rules (also add-only): plant-material=Artificial on any category; for Wreaths,
    // material = Synthetic + the chosen Decoration/Planter materials (crosswalked).
    if (categoryGid) unionInto('plant-material', [SHOPIFY_PLANT_MATERIAL_ARTIFICIAL]);
    if (product_category === 'Wreaths') unionInto('material', await resolveWreathMaterialGids(req.body));

    // 3. Apply category + merged metafields (one productUpdate; add-only so safe)
    let mfErrors = [];
    if (categoryGid || mf.length) {
      const productInput = { id: productId };
      if (categoryGid) productInput.category = categoryGid;
      if (mf.length) productInput.metafields = mf;
      const upData = await shopifyGraphql(`mutation productUpdate($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{field message}}}`, { product: productInput });
      mfErrors = upData?.data?.productUpdate?.userErrors || [];
      if (mfErrors.length) console.warn('Resync metafield userErrors:', mfErrors.map(e => e.message).join(', '));
      else console.log('Resync metafields:', sku, '→ added', JSON.stringify(added));
    }

    // 3b. Care instructions → custom.care_instructions (tool-owned; whole-value replace). Own update.
    const careList = (Array.isArray(care_instructions) ? care_instructions : (care_instructions ? [care_instructions] : [])).filter(Boolean);
    if (careList.length) {
      try {
        await shopifyGraphql(`mutation productUpdate($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{message}}}`, { product: { id: productId, metafields: [{ namespace: 'custom', key: 'care_instructions', type: 'list.single_line_text_field', value: JSON.stringify(careList) }] } });
      } catch (ciErr) { console.warn('Resync care_instructions failed (non-fatal):', ciErr.message); }
    }

    // 3c. Indoor/Outdoor → custom.indoor_outdoor (tool-owned multi-select; whole-value replace).
    const ioList = mapIndoorOutdoorList(indoor_outdoor);
    if (ioList.length) {
      try {
        await shopifyGraphql(`mutation productUpdate($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{message}}}`, { product: { id: productId, metafields: [{ namespace: 'custom', key: 'indoor_outdoor', type: 'list.single_line_text_field', value: JSON.stringify(ioList) }] } });
      } catch (ioErr) { console.warn('Resync indoor_outdoor failed (non-fatal):', ioErr.message); }
    }

    // 3d. Suggested display → custom.suggested_display (tool-owned multi-select; whole-value replace).
    const sdList = (Array.isArray(suggested_display) ? suggested_display : (suggested_display ? [suggested_display] : [])).filter(Boolean);
    if (sdList.length) {
      try {
        await shopifyGraphql(`mutation productUpdate($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{message}}}`, { product: { id: productId, metafields: [{ namespace: 'custom', key: 'suggested_display', type: 'list.single_line_text_field', value: JSON.stringify(sdList) }] } });
      } catch (sdErr) { console.warn('Resync suggested_display failed (non-fatal):', sdErr.message); }
    }

    // 4. Reset inventory to the tool Quantity (default 1). Decided behaviour for now.
    let inventory = null;
    const qty = (quantity != null && quantity !== '' && Number.isFinite(Number(quantity))) ? Math.max(0, Math.round(Number(quantity))) : 1;
    if (inventoryItemId) {
      const locRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/locations.json`, { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
      const locData = await locRes.json();
      const locationId = locData.locations && locData.locations[0] && locData.locations[0].id;
      if (locationId) {
        // 2026-04: @idempotent directive + per-quantity changeFromQuantity both required (see /create-product note).
        const invData = await shopifyGraphql(`mutation invSet($input:InventorySetQuantitiesInput!,$idem:String!){inventorySetQuantities(input:$input)@idempotent(key:$idem){userErrors{message}}}`, { input: { name: 'available', reason: 'correction', quantities: [{ inventoryItemId, locationId: `gid://shopify/Location/${locationId}`, quantity: qty, changeFromQuantity: null }] }, idem: crypto.randomUUID() });
        const invErrs = invData?.data?.inventorySetQuantities?.userErrors || [];
        inventory = invErrs.length ? ('error: ' + invErrs.map(e => e.message).join(', ')) : qty;
      }
    }
    res.json({ success: mfErrors.length === 0, product_id: String(productId).split('/').pop(), added, inventory, note: 'Add-only: existing Shopify values kept; title/description/images/price untouched.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drive: list video files in a specific folder ─────────────
app.get('/drive-folder-videos', async (req, res) => {
  const { folderId } = req.query;
  if (!folderId) return res.status(400).json({ error: 'folderId required' });
  try {
    const query = `'${folderId}' in parents and mimeType contains 'video/' and trashed = false`;
    let files = [], pageToken = null;
    do {
      let url = '/files?pageSize=50&q=' + encodeURIComponent(query)
        + '&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&orderBy=modifiedTime desc';
      if (pageToken) url += '&pageToken=' + pageToken;
      const data = await driveRequest(url);
      files = files.concat(data.files || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    res.json({ files, total: files.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Shopify: add video to product — staged upload pipeline ────
// Flow: Drive (authenticated download) → Shopify GCS staged slot
// (multipart POST) → productCreateMedia(resourceUrl).
// NOTE: httpMethod must be POST for video — GCS signed URLs for
// video use form-field auth (x-goog-signature, policy, etc.) that
// only works as multipart POST.  PUT triggers MissingSecurityHeader
// because the signed URL is not a V4 query-param signed URL.
app.post('/shopify-add-video', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized — visit /auth' });
  const { productId, fileId, fileName, position } = req.body;
  if (!productId || !fileId) return res.status(400).json({ error: 'productId and fileId required' });
  try {
    const token = await getValidGoogleToken();

    // 1. Get file metadata (size + MIME type) — required by stagedUploadsCreate
    const metaRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=size,mimeType,name`,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    if (!metaRes.ok) throw new Error('Drive metadata fetch failed: ' + metaRes.status);
    const meta = await metaRes.json();
    const fileSize = meta.size;
    const mimeType = meta.mimeType || 'video/quicktime';
    const name     = fileName || meta.name || 'product-video.mov';
    if (!fileSize) throw new Error('Could not determine file size from Drive');

    // 2. Ask Shopify for a GCS staged upload slot (POST = multipart form upload)
    const stageMutation = `mutation stagedUploadsCreate($input:[StagedUploadInput!]!){stagedUploadsCreate(input:$input){stagedTargets{url resourceUrl parameters{name value}}userErrors{field message}}}`;
    const stageRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: stageMutation, variables: {
        input: [{ filename: name, mimeType, resource: 'VIDEO', fileSize: String(fileSize), httpMethod: 'POST' }]
      }})
    });
    const stageData = await stageRes.json();
    const stageErrors = stageData?.data?.stagedUploadsCreate?.userErrors || [];
    if (stageErrors.length) throw new Error('Staged upload error: ' + stageErrors.map(e=>e.message).join(', '));
    const target = stageData?.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target?.url || !target?.resourceUrl) throw new Error('No staged upload target returned from Shopify');

    // 3. Open the Drive download as a stream (server auth token, no public sharing).
    //    videoRes.body is a Node Readable — bytes are never buffered into memory.
    const videoRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    if (!videoRes.ok) throw new Error('Drive video download failed: ' + videoRes.status);

    // 4. Stream straight into the GCS multipart POST — parameters MUST come before
    //    the file field. knownLength (from Drive metadata) lets form-data set a correct
    //    Content-Length without measuring bytes, so peak memory stays flat regardless
    //    of video size. form.submit() pipes the Drive stream directly to GCS.
    const form = new FormData();
    for (const p of (target.parameters || [])) { form.append(p.name, p.value); }
    form.append('file', videoRes.body, { knownLength: Number(fileSize), contentType: mimeType, filename: name });

    await new Promise((resolve, reject) => {
      form.submit(target.url, (err, uploadRes) => {
        if (err) return reject(err);
        const status = uploadRes.statusCode;
        let errText = '';
        uploadRes.on('data', c => { if (status >= 300 && errText.length < 300) errText += c.toString(); });
        uploadRes.on('end', () => {
          if (status < 200 || status >= 300) {
            return reject(new Error(`GCS upload failed (${status}): ${errText.slice(0, 300)}`));
          }
          resolve();
        });
        uploadRes.on('error', reject);
      });
    });

    // 5. Attach the confirmed GCS resource to the Shopify product
    const gidProductId = String(productId).startsWith('gid://') ? String(productId) : `gid://shopify/Product/${productId}`;
    const mediaMutation = `mutation productCreateMedia($media:[CreateMediaInput!]!,$productId:ID!){productCreateMedia(media:$media,productId:$productId){media{id alt mediaContentType status}mediaUserErrors{field message}}}`;
    const mediaRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: mediaMutation, variables: {
        productId: gidProductId,
        media: [{ originalSource: target.resourceUrl, alt: name, mediaContentType: 'VIDEO' }]
      }})
    });
    const mediaData = await mediaRes.json();
    const mediaErrors = mediaData?.data?.productCreateMedia?.mediaUserErrors || [];
    if (mediaErrors.length) throw new Error(mediaErrors.map(e=>e.message).join(', '));
    const createdMedia = mediaData?.data?.productCreateMedia?.media || [];

    // 6. Optionally move the video right after the hero image (media position 1,
    //    0-indexed). Non-fatal: a reorder failure still leaves the video attached
    //    at the end, so we never fail the request over it.
    let reordered = false;
    const videoMediaId = createdMedia[0]?.id;
    if (position === 'after_hero' && videoMediaId) {
      try {
        const reorderMutation = `mutation productReorderMedia($id:ID!,$moves:[MoveInput!]!){productReorderMedia(id:$id,moves:$moves){mediaUserErrors{field message}}}`;
        const reorderRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/graphql.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: reorderMutation, variables: {
            id: gidProductId,
            moves: [{ id: videoMediaId, newPosition: '1' }]
          }})
        });
        const reorderData = await reorderRes.json();
        const reorderErrors = reorderData?.data?.productReorderMedia?.mediaUserErrors || [];
        if (reorderErrors.length) console.warn('Video reorder skipped:', reorderErrors.map(e=>e.message).join(', '));
        else reordered = true;
      } catch(reErr) { console.warn('Video reorder failed (non-fatal):', reErr.message); }
    }

    console.log(`Video uploaded: ${name} (${Math.round(Number(fileSize)/1024/1024)}MB) → product ${productId}${reordered ? ' (positioned after hero)' : ''}`);
    res.json({ success: true, media: createdMedia, reordered });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drive: list subfolders with modifiedTime (ranked folder picker) ──
// Replaces the bare folder list with extra metadata for scoring.
app.get('/drive-list-subfolders-ranked', async (req, res) => {
  const { parentId } = req.query;
  if (!parentId) return res.status(400).json({ error: 'parentId required' });
  try {
    const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    let folders = [], pageToken = null;
    do {
      let url = '/files?pageSize=100&q=' + encodeURIComponent(query)
        + '&fields=nextPageToken,files(id,name,modifiedTime)&orderBy=name';
      if (pageToken) url += '&pageToken=' + pageToken;
      const data = await driveRequest(url);
      folders = folders.concat(data.files || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    res.json({ folders, total: folders.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── One-time recovery: backfill Listing Meta Description from Shopify ────────
// Fetches every listed Airtable record, looks up its Shopify product, pulls the
// saved SEO meta description, and writes it to the new Airtable field.
// Safe to run multiple times — skips any record that already has the field set.
app.post('/recovery/backfill-meta', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized — visit /auth first' });
  try {
    // 1 ── Pull all Airtable inventory records (paginated)
    let atRecords = [], offset = null;
    do {
      let path = `${AT_INVENTORY_TBL}?pageSize=100`;
      if (offset) path += '&offset=' + encodeURIComponent(offset);
      const page = await airtableReq(path);
      atRecords = atRecords.concat(page.records || []);
      offset = page.offset || null;
    } while (offset);

    // 2 ── Filter to listed pieces that have a Shopify URL
    const listed = atRecords.filter(r =>
      r.fields['Status'] === 'Listed' && r.fields['Shopify URL']
    );

    const results = [];

    for (const record of listed) {
      const f      = record.fields;
      const ebRaw  = f['EB Number'] || '';
      const eb     = (ebRaw.match(/^(EB-\d{2}[A-Z]{2}-[A-Z]{2,3}-\d{3})/i) || [])[1] || ebRaw;
      const url    = f['Shopify URL'] || '';

      // Skip if already has a value
      if (f['Listing Meta Description']) {
        results.push({ eb, status: 'skipped', reason: 'already set' });
        continue;
      }

      // Extract product handle from Shopify storefront URL
      const handleMatch = url.match(/\/products\/([^/?#]+)/);
      if (!handleMatch) {
        results.push({ eb, status: 'error', reason: 'could not parse URL: ' + url });
        continue;
      }
      const handle = handleMatch[1];

      try {
        // Look up product ID by handle
        const prodRes  = await fetch(
          `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?handle=${encodeURIComponent(handle)}&fields=id`,
          { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
        );
        const prodData = await prodRes.json();
        const productId = prodData.products && prodData.products[0] && prodData.products[0].id;

        if (!productId) {
          results.push({ eb, status: 'not-found', reason: 'no Shopify product for handle: ' + handle });
          continue;
        }

        // Fetch the global description_tag metafield
        const mfRes  = await fetch(
          `https://${SHOPIFY_STORE}/admin/api/2026-04/products/${productId}/metafields.json?namespace=global&key=description_tag`,
          { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
        );
        const mfData = await mfRes.json();
        const meta   = mfData.metafields && mfData.metafields[0] && mfData.metafields[0].value;

        if (!meta) {
          results.push({ eb, status: 'no-meta', reason: 'product found but no SEO meta stored' });
          continue;
        }

        // Write back to Airtable
        await airtableReq(`${AT_INVENTORY_TBL}/${record.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ fields: { 'Listing Meta Description': meta } })
        });

        results.push({ eb, status: 'updated', meta });

        // Polite pause — avoids hitting Shopify rate limits
        await new Promise(r => setTimeout(r, 250));

      } catch(e) {
        results.push({ eb, status: 'error', reason: e.message });
      }
    }

    const counts = {
      total:    listed.length,
      updated:  results.filter(r => r.status === 'updated').length,
      skipped:  results.filter(r => r.status === 'skipped').length,
      no_meta:  results.filter(r => r.status === 'no-meta').length,
      not_found:results.filter(r => r.status === 'not-found').length,
      errors:   results.filter(r => r.status === 'error').length,
    };
    res.json({ success: true, ...counts, results });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Shopify: get numeric product ID from handle (for video add on already-listed pieces) ──
app.get('/shopify-product-id', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized' });
  const { handle } = req.query;
  if (!handle) return res.status(400).json({ error: 'handle required' });
  try {
    const r = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?handle=${encodeURIComponent(handle)}&fields=id`,
      { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
    );
    const d = await r.json();
    const productId = d.products && d.products[0] && d.products[0].id;
    if (!productId) return res.status(404).json({ error: 'Product not found: ' + handle });
    res.json({ productId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Shopify: update SEO meta description on existing product ─────────────────
// Writes to both Airtable and the Shopify product metafield in one call.
app.post('/shopify-update-meta', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized — visit /auth' });
  const { productHandle, airtableRecordId, metaDescription } = req.body;
  if (!productHandle || !metaDescription) return res.status(400).json({ error: 'productHandle and metaDescription required' });
  try {
    // Resolve product ID from handle
    const prodRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?handle=${encodeURIComponent(productHandle)}&fields=id`,
      { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
    );
    const prodData = await prodRes.json();
    const productId = prodData.products && prodData.products[0] && prodData.products[0].id;
    if (!productId) return res.status(404).json({ error: 'Product not found: ' + productHandle });

    // Check for existing description_tag metafield
    const mfRes = await fetch(
      `https://${SHOPIFY_STORE}/admin/api/2026-04/products/${productId}/metafields.json?namespace=global&key=description_tag`,
      { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } }
    );
    const mfData = await mfRes.json();
    const existing = mfData.metafields && mfData.metafields[0];

    let shopifyRes;
    if (existing) {
      shopifyRes = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2026-04/products/${productId}/metafields/${existing.id}.json`,
        { method: 'PUT', headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ metafield: { id: existing.id, value: metaDescription } }) }
      );
    } else {
      shopifyRes = await fetch(
        `https://${SHOPIFY_STORE}/admin/api/2026-04/products/${productId}/metafields.json`,
        { method: 'POST', headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ metafield: { namespace: 'global', key: 'description_tag', value: metaDescription, type: 'single_line_text_field' } }) }
      );
    }
    const shopifyResult = await shopifyRes.json();
    if (!shopifyRes.ok) return res.status(shopifyRes.status).json({ error: shopifyResult.errors || 'Shopify metafield error' });

    // Write to Airtable if record ID provided
    if (airtableRecordId) {
      await airtableReq(`${AT_INVENTORY_TBL}/${airtableRecordId}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { 'Listing Meta Description': metaDescription } })
      });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Recovery: generate proper SEO metas for all listed pieces ─────────────────
// For each listed Airtable record: fetches the Shopify title + description,
// generates a 140-160 char SEO meta via AI, writes to Airtable and Shopify.
app.post('/recovery/generate-and-set-seo', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized' });
  if (!ANTHROPIC_API_KEY)  return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    // Pull all Airtable inventory records
    let atRecords = [], offset = null;
    do {
      let path = `${AT_INVENTORY_TBL}?pageSize=100`;
      if (offset) path += '&offset=' + encodeURIComponent(offset);
      const page = await airtableReq(path);
      atRecords = atRecords.concat(page.records || []);
      offset = page.offset || null;
    } while (offset);

    const listed = atRecords.filter(r => r.fields['Status'] === 'Listed' && r.fields['Shopify URL']);
    const results = [];

    for (const record of listed) {
      const f   = record.fields;
      const eb  = ((f['EB Number'] || '').match(/^(EB-\d{2}[A-Z]{2}-[A-Z]{2,3}-\d{3})/i) || [])[1] || f['EB Number'] || '';
      const url = f['Shopify URL'] || '';
      const handleMatch = url.match(/\/products\/([^/?#]+)/);
      if (!handleMatch) { results.push({ eb, status: 'error', reason: 'bad URL' }); continue; }
      const handle = handleMatch[1];

      try {
        // Get Shopify product title + description
        const prodRes  = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products.json?handle=${encodeURIComponent(handle)}&fields=id,title,body_html`,
          { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
        const prodData = await prodRes.json();
        const product  = prodData.products && prodData.products[0];
        if (!product) { results.push({ eb, status: 'not-found', reason: 'no Shopify product' }); continue; }

        const prodTitle = product.title || '';
        const prodDesc  = (product.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').trim().slice(0, 400);

        // Generate SEO meta via Claude
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', max_tokens: 200,
            messages: [{ role: 'user', content:
              `Write a Google SEO meta description for this handmade floral product listing.\n` +
              `- Must be 140-160 characters (count carefully)\n` +
              `- Include 2-3 strong keywords from the title\n` +
              `- Describe the product enticingly, like a call to click\n` +
              `- Do NOT start with the exact title text\n` +
              `- Return ONLY the meta description text, nothing else\n\n` +
              `Product title: ${prodTitle}\n` +
              `Product description: ${prodDesc}`
            }]
          })
        });
        const aiData = await aiRes.json();
        const seoMeta = ((aiData.content && aiData.content[0] && aiData.content[0].text) || '').trim();
        if (!seoMeta) { results.push({ eb, status: 'ai-failed', reason: 'empty AI response' }); continue; }

        // Write to Airtable
        await airtableReq(`${AT_INVENTORY_TBL}/${record.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ fields: { 'Listing Meta Description': seoMeta } })
        });

        // Update Shopify metafield
        const mfRes     = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products/${product.id}/metafields.json?namespace=global&key=description_tag`,
          { headers: { 'X-Shopify-Access-Token': shopifyAccessToken } });
        const mfData    = await mfRes.json();
        const existingMf = mfData.metafields && mfData.metafields[0];
        if (existingMf) {
          await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products/${product.id}/metafields/${existingMf.id}.json`,
            { method: 'PUT', headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ metafield: { id: existingMf.id, value: seoMeta } }) });
        } else {
          await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/products/${product.id}/metafields.json`,
            { method: 'POST', headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ metafield: { namespace: 'global', key: 'description_tag', value: seoMeta, type: 'single_line_text_field' } }) });
        }

        results.push({ eb, status: 'updated', seoMeta, title: prodTitle });
        await new Promise(r => setTimeout(r, 500)); // rate-limit padding

      } catch(e) { results.push({ eb, status: 'error', reason: e.message }); }
    }

    res.json({ success: true, total: listed.length,
      updated: results.filter(r=>r.status==='updated').length,
      errors:  results.filter(r=>['error','ai-failed','not-found'].includes(r.status)).length,
      results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Ensure the orders/create webhook is registered (idempotent, runs on startup) ──
// Registers a webhook pointing at THIS server so online Shopify orders auto-sync to
// Airtable. Safe on every boot: it checks for an existing subscription first, and
// requires the app to have the read_orders scope (already in the OAuth scope string).
async function ensureOrderWebhook() {
  if (!shopifyAccessToken) { console.log('orders webhook: no Shopify token yet — skipping registration (visit /auth).'); return; }
  if (!SERVER_URL) { console.warn('orders webhook: SERVER_URL not set — cannot register callback address.'); return; }
  const address = `${SERVER_URL.replace(/\/$/, '')}/webhooks/orders-create`;
  try {
    const listRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/webhooks.json?topic=orders/create&limit=250`, {
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken }
    });
    const listData = await listRes.json();
    if (!listRes.ok) { console.warn('orders webhook: could not list existing webhooks —', JSON.stringify(listData.errors || listData)); return; }
    const existing = (listData.webhooks || []).find(w => w.address === address);
    if (existing) { console.log(`orders webhook: already registered (#${existing.id}) → ${address}`); return; }
    const createRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/webhooks.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook: { topic: 'orders/create', address, format: 'json' } })
    });
    const createData = await createRes.json();
    if (!createRes.ok) { console.warn('orders webhook: registration FAILED —', JSON.stringify(createData.errors || createData), '(the app likely needs the read_orders scope granted)'); return; }
    console.log(`orders webhook: registered (#${createData.webhook && createData.webhook.id}) → ${address}`);
  } catch (e) { console.warn('orders webhook: registration error —', e.message); }
}

// Register the products/update webhook so Sale/Clearance markdowns made directly in
// Shopify sync back to Airtable. Mirrors ensureOrderWebhook; needs only read_products
// (already granted), so unlike the orders webhook it doesn't wait on a scope grant.
async function ensureProductWebhook() {
  if (!shopifyAccessToken) { console.log('products webhook: no Shopify token yet — skipping registration (visit /auth).'); return; }
  if (!SERVER_URL) { console.warn('products webhook: SERVER_URL not set — cannot register callback address.'); return; }
  const address = `${SERVER_URL.replace(/\/$/, '')}/webhooks/products-update`;
  try {
    const listRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/webhooks.json?topic=products/update&limit=250`, {
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken }
    });
    const listData = await listRes.json();
    if (!listRes.ok) { console.warn('products webhook: could not list existing webhooks —', JSON.stringify(listData.errors || listData)); return; }
    const existing = (listData.webhooks || []).find(w => w.address === address);
    if (existing) { console.log(`products webhook: already registered (#${existing.id}) → ${address}`); return; }
    const createRes = await fetch(`https://${SHOPIFY_STORE}/admin/api/2026-04/webhooks.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': shopifyAccessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook: { topic: 'products/update', address, format: 'json' } })
    });
    const createData = await createRes.json();
    if (!createRes.ok) { console.warn('products webhook: registration FAILED —', JSON.stringify(createData.errors || createData)); return; }
    console.log(`products webhook: registered (#${createData.webhook && createData.webhook.id}) → ${address}`);
  } catch (e) { console.warn('products webhook: registration error —', e.message); }
}

// ── Marketing queue: Pinterest, Instagram and Facebook drafts, approved by Patti before posting ──
// Approving posts automatically once the channel is connected; until then EB Master offers a
// by-hand fallback. Drafts live in the Airtable "Marketing Queue" table.
// Candidates come straight from Shopify (active, in stock) because older product handles
// don't follow the EB-number pattern; the Season_/Holiday_/Type_ tags drive seasonality.
const AT_MARKETING_TBL = 'tblUeywr9I8jflj0O';
// One row per piece per channel. All channels share the same columns: Description holds the
// pin description, Instagram caption or Facebook post, and Pin ID / Pin URL hold the live post.
const MKT_CHANNELS = ['Pinterest', 'Instagram', 'Facebook'];
const mktChannel = f => (f && f['Channel']) || 'Pinterest';
const MKT_EDITABLE_FIELDS = ['Pin Title', 'Description', 'Board', 'Alt Text', 'Status', 'Pin URL', 'Notes', 'Scheduled for', 'Logo', 'Video version'];
const MKT_STATUSES = ['Draft', 'Approved', 'Posted', 'Skipped'];
// Starter boards — the AI must pick one so boards stay few and searchable.
const PIN_BOARDS = [
  'Fall Front Door Wreaths', 'Fall Home Decor', 'Christmas Wreaths & Decor', 'Christmas Centerpieces',
  'Winter Home Decor', 'Spring Wreaths & Florals', 'Summer Porch & Patio Florals', 'Patriotic & Summer Wreaths',
  'Dining Table Centerpieces', 'Entryway & Console Florals', 'Wall Decor & Swags', 'Everyday Faux Florals'
];
// Seasonal calendar, timed to when stores set out seasonal displays and Pinterest shoppers start
// planning (about 6–10 weeks ahead). A theme is promoted from start to end (month, day); Easter
// moves, so its window is days relative to Easter Sunday. Product tags pick a theme's pieces.
const MKT_THEMES = [
  { name: "Valentine's Day", start: [12, 26], end: [2, 10], tags: /valentine/ },
  { name: 'Winter', start: [12, 1], end: [2, 15], tags: /season_winter/ },
  { name: 'Spring', start: [2, 15], end: [5, 15], tags: /season_spring/ },
  { name: 'Easter', easter: [-56, 0], tags: /easter/ },
  { name: "Mother's Day", start: [3, 25], end: [5, 8], tags: /mother/ },
  { name: 'Fourth of July', start: [5, 15], end: [7, 3], tags: /fourth|memorial/ },
  { name: 'Summer', start: [5, 1], end: [8, 15], tags: /season_summer/ },
  { name: 'Fall', start: [8, 1], end: [10, 31], tags: /season_fall/ },
  { name: 'Halloween', start: [8, 15], end: [10, 25], tags: /halloween/ },
  { name: 'Thanksgiving', start: [9, 15], end: [11, 20], tags: /thanksgiving/ },
  { name: 'Christmas', start: [9, 15], end: [12, 18], tags: /christmas/ }
];
// Year-round angles Patti can pick by hand; not on the calendar.
const MKT_EXTRA_THEMES = [
  { name: 'Everyday', tags: /all[_ ]?season|everyday/ },
  { name: 'Sympathy & memorial', tags: /sympathy|funeral|memorial/ },
  { name: 'Weddings & showers', tags: /wedding|bridal|baby_shower/ }
];
const MKT_ALL_THEMES = [...MKT_THEMES, ...MKT_EXTRA_THEMES];
const MKT_DAY_MS = 24 * 60 * 60 * 1000;
const mktTagText = p => (p.tags || []).join(' ').toLowerCase();
const mktTheme = name => MKT_ALL_THEMES.find(t => t.name === name) || null;
function mktEaster(y) { // Gregorian computus
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(Date.UTC(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1));
}
function mktThemeWindows(t, y) {
  if (t.easter) { const e = mktEaster(y).getTime(); return [{ start: new Date(e + t.easter[0] * MKT_DAY_MS), end: new Date(e + t.easter[1] * MKT_DAY_MS + MKT_DAY_MS - 1) }]; }
  const at = (yr, [mo, da], endOfDay) => new Date(Date.UTC(yr, mo - 1, da) + (endOfDay ? MKT_DAY_MS - 1 : 0));
  return t.start[0] > t.end[0]
    ? [{ start: at(y - 1, t.start), end: at(y, t.end, true) }, { start: at(y, t.start), end: at(y + 1, t.end, true) }]
    : [{ start: at(y, t.start), end: at(y, t.end, true) }];
}
// Themes in season now (soonest-ending first), then those starting within the next 3 weeks.
function mktCalendar(now = new Date()) {
  const out = [];
  for (const t of MKT_THEMES) {
    const wins = [...mktThemeWindows(t, now.getUTCFullYear()), ...mktThemeWindows(t, now.getUTCFullYear() + 1)];
    const w = wins.find(w => w.end >= now && w.start - now <= 21 * MKT_DAY_MS);
    if (w) out.push({ name: t.name, start: w.start.toISOString().slice(0, 10), end: w.end.toISOString().slice(0, 10), active: w.start <= now });
  }
  return out.sort((a, b) => (b.active - a.active) || a.end.localeCompare(b.end) || a.start.localeCompare(b.start));
}
// The angle a piece gets by default: the first in-season theme its tags match.
function mktAutoTheme(p, now = new Date()) {
  const t = mktTagText(p);
  const hit = mktCalendar(now).find(c => c.active && mktTheme(c.name).tags.test(t));
  return hit ? hit.name : '';
}

// Posting history per piece and channel, from the queue itself. A piece can be drafted again on a
// channel once nothing is open there and its last post (or skip) is MKT_COOLDOWN_MS old; Patti can
// pick a piece by hand any time.
const MKT_COOLDOWN_MS = 30 * MKT_DAY_MS;
function mktHistory(records) {
  const out = {}; // sku → channel → { open, last, posts: [fields, newest first] }
  for (const r of records) {
    const f = r.fields || {}, sku = String(f['EB Number'] || '').trim();
    if (!sku) continue;
    const h = ((out[sku] = out[sku] || {})[mktChannel(f)] = (out[sku] || {})[mktChannel(f)] || { open: null, last: 0, posts: [] });
    if (f['Status'] === 'Draft' || f['Status'] === 'Approved') h.open = r;
    else {
      h.last = Math.max(h.last, Date.parse(f['Status changed'] || f['Drafted'] || '') || 0);
      if (f['Status'] === 'Posted') h.posts.push(f);
    }
  }
  for (const chans of Object.values(out)) for (const h of Object.values(chans)) h.posts.sort((a, b) => String(b['Status changed'] || '').localeCompare(String(a['Status changed'] || '')));
  return out;
}
const mktEverPosted = (hist, sku) => Object.values(hist[sku] || {}).some(h => h.posts.length);
const mktLastPosted = (hist, sku) => Math.max(0, ...Object.values(hist[sku] || {}).map(h => h.last));
// Condensed from the approved "Eternal Blooms Brand Voice Guide" (Claude Doc, 2026-10-25).
const PIN_VOICE_RULES = `Brand: Eternal Blooms by Patti — handcrafted, one-of-a-kind faux floral arrangements "for hearts & homes". Tagline: "Florals that bloom forever." Tone: warm, not gushing; specific over generic (name colors, flowers, textures, where it looks best); calm confidence, no hard sell or urgency tricks; helpful about placement (entryway, dining table, mantel, covered porch).
Pins describe the PIECE, with a light "handmade by Patti" touch (once, naturally — e.g. "handmade by Patti"). Never mention Omaha, Nebraska, or any location.
Formatting: sentence case for copy, Title Case for the pin title only. Use "&" in brand phrases. No emoji. No exclamation points. No hashtags. Numbers as digits. No price, "sale", or discount wording.
Use: handcrafted, handmade, one-of-a-kind, faux florals, artificial flowers, lifelike, lasts for years, no watering, low-maintenance, seasonal, timeless. Say "real-touch" or "premium greenery" only if the product text says so.
Never say: bespoke, made to order, small batches, free returns, fake, plastic, cheap, weatherproof, lasts forever outdoors, "no two are ever the same", "can never be recreated". Do not tout silk as a selling point. Outdoor pieces: "made for covered porches & sheltered spots".`;
// Instagram and Facebook differ from pins in who speaks (voice guide section 3). Shared word
// lists, tone and facts come from PIN_VOICE_RULES; these lines override its pin-only rules.
const SOCIAL_VOICE_RULES = `Instagram caption: about the PIECE (national audience), with the same light "handmade by Patti" touch. Never mention Omaha, Nebraska, or any location. Links aren't clickable on Instagram, so the call to action points to the shop "link in bio".
Facebook post: written by Patti in the first person ("I"), warm and local; mentioning Omaha is fine. At most one exclamation point. Signed "— Patti". Don't add a link; it is appended automatically.
Both: sentence case, no emoji, no price or sale wording, 0–3 relevant hashtags at the very end (or none). These rules replace the pin rules about exclamation points and hashtags.`;

// The app reads the queue on every open (for the home-screen badge), so keep a short-lived
// copy like the inventory cache; writes through this server update it in place.
const MKT_FRESH_MS = 5 * 60 * 1000;
const mktCache = { records: null, at: 0 };
async function mktRecords({ force = false } = {}) {
  if (!force && mktCache.records && Date.now() - mktCache.at < MKT_FRESH_MS) return mktCache.records;
  mktCache.records = await mktFetchAll();
  mktCache.at = Date.now();
  return mktCache.records;
}
function mktCacheUpsert(recs) {
  if (!mktCache.records) return;
  for (const r of recs) {
    const i = mktCache.records.findIndex(x => x.id === r.id);
    if (i >= 0) mktCache.records[i] = r; else mktCache.records.unshift(r);
  }
}
async function mktFetchAll() {
  let out = [], offset = null;
  do {
    let path = `${AT_MARKETING_TBL}?pageSize=100&sort%5B0%5D%5Bfield%5D=Drafted&sort%5B0%5D%5Bdirection%5D=desc`;
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    const data = await airtableReq(path);
    out = out.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);
  return out;
}

// Active, in-stock Shopify products with their SKU (= EB Number), tags, photos and videos.
let mktCandCache = { at: 0, list: null };
async function mktShopifyCandidates() {
  if (mktCandCache.list && Date.now() - mktCandCache.at < MKT_FRESH_MS) return mktCandCache.list;
  const out = []; let cursor = null;
  do {
    const d = await shopifyGraphql(`query($after:String){products(first:100,after:$after,query:"status:active inventory_total:>0"){nodes{title handle onlineStoreUrl productType tags description(truncateAt:700) variants(first:1){nodes{sku}} media(first:10){nodes{... on MediaImage{image{url width height altText}} ... on Video{duration sources{url format width height}}}}} pageInfo{hasNextPage endCursor}}}`, { after: cursor });
    const conn = d && d.data && d.data.products;
    if (!conn) throw new Error('Shopify product query failed: ' + JSON.stringify((d && d.errors) || d));
    out.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  mktCandCache = { at: Date.now(), list: out };
  return out;
}

// Portrait photos crop best into Pinterest's 2:3 frame, so prefer the tallest image.
function mktPickImage(p) {
  const imgs = ((p.media && p.media.nodes) || []).map(n => n && n.image).filter(i => i && i.url);
  if (!imgs.length) return null;
  return imgs.slice().sort((a, b) => (b.height / b.width) - (a.height / a.width))[0];
}

// Listing videos become video pins when Pinterest will show them well: at least 4 s long
// (Pinterest's minimum) and vertical or square (landscape plays tiny in the feed). Shopify
// keeps MP4 renditions of each .mov upload; take the largest one, up to 1080×1920.
const PIN_VIDEO_MIN_MS = 4000;
function mktPickVideo(p) {
  const vids = ((p.media && p.media.nodes) || []).filter(n => n && n.sources && n.duration >= PIN_VIDEO_MIN_MS);
  for (const v of vids) {
    const mp4 = v.sources.filter(s => s.format === 'mp4' && s.url && s.height >= s.width && s.height <= 1920)
      .sort((a, b) => b.height - a.height)[0];
    if (mp4) return mp4.url;
  }
  return null;
}

// Where a pin points once its piece sells: the matching in-stock collection.
const SHOP_COLLECTIONS_URL = 'https://eternalbloomsbypatti.com/collections/';
function mktSimilarUrl(p) {
  const t = (p.tags || []).join(' ').toLowerCase();
  if (p.productType === 'Wreath') return SHOP_COLLECTIONS_URL + 'wreaths';
  if (p.productType === 'Outdoor planter') return SHOP_COLLECTIONS_URL + 'outdoor-planters';
  for (const s of ['fall', 'winter', 'spring', 'summer']) if (t.includes('season_' + s)) return SHOP_COLLECTIONS_URL + s + '-arrangements';
  if (/season_all[_ ]?season/.test(t)) return SHOP_COLLECTIONS_URL + 'all-season-arrangements';
  return SHOP_COLLECTIONS_URL + 'shop-all';
}

// Shop links in posts carry UTM tags so Shopify's reports can credit visits and sales to the
// channel and piece: utm_source = channel, utm_content = EB number, utm_campaign = new or repost.
// Visits from inside the Instagram/Facebook apps otherwise often show up as "direct".
function mktTrackedUrl(url, f, { sold = false } = {}) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', mktChannel(f).toLowerCase());
    u.searchParams.set('utm_medium', 'social');
    u.searchParams.set('utm_campaign', sold ? 'sold-redirect' : f['Post type'] === 'Repost' ? 'repost' : 'new-post');
    if (f['EB Number']) u.searchParams.set('utm_content', f['EB Number']);
    return u.toString();
  } catch (e) { return url; }
}
// The post text with every plain copy of the product link swapped for the tagged one.
const mktTrackText = (text, f) => f['Product URL'] ? String(text || '').split(f['Product URL']).join(mktTrackedUrl(f['Product URL'], f)) : text;

function mktSeasonScore(p, now) {
  const t = mktTagText(p);
  if (mktAutoTheme(p, now)) return 2;
  if (/all[_ ]?season|everyday/.test(t) || !/season_|holiday_/.test(t)) return 1;
  return 0;
}

// Extra prompt lines for a seasonal angle and for reposts (earlier text the AI must not repeat).
function mktAngleLines(theme, previous, what) {
  const lines = [];
  if (theme) lines.push(`Seasonal angle: present this piece for ${theme} — how and where it fits that season or occasion. Stay truthful to what the piece is; if it only loosely fits, keep the angle light.`);
  if (previous && previous.length) lines.push(`This piece has been posted before. Write a FRESH ${what}: a different opening, different details emphasized, and no sentence reused from these earlier versions:\n${previous.map(t => '- ' + String(t).replace(/\s+/g, ' ').slice(0, 400)).join('\n')}`);
  return lines.join('\n');
}

async function mktDraftPin(p, img, ctx = {}) {
  const textPrompt = `${PIN_VOICE_RULES}
${mktAngleLines(ctx.theme, ctx.previous, 'pin')}

Write ONE Pinterest pin for this product.
- title: under 100 characters, Title Case, starting with the search phrase a shopper would type (e.g. "Fall Door Wreath", "Farmhouse Dining Table Centerpiece"), then the standout detail.
- description: 2–3 sentences, under 500 characters. Sentence 1 says what it is and where it goes. Weave in 2–3 search phrases naturally. Include the light "handmade by Patti" touch. End with a soft call to action such as "Shop this one-of-a-kind piece."
- board: EXACTLY one of: ${PIN_BOARDS.join(' | ')}
- alt_text: one plain sentence describing what the photo shows, for screen readers.
${img ? 'The product photo is attached — use what you can see.' : ''}

Product title: ${p.title}
Product type: ${p.productType || 'arrangement'}
Tags: ${(p.tags || []).join(', ')}
Product description: ${p.description || ''}

Return ONLY valid JSON, no code fences: {"title": "...", "description": "...", "board": "...", "alt_text": "..."}`;
  const content = img
    ? [{ type: 'image', source: { type: 'url', url: img.url } }, { type: 'text', text: textPrompt }]
    : textPrompt;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 700, messages: [{ role: 'user', content }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || 'Anthropic API error');
  const raw = (data.content && data.content[0] && data.content[0].text || '').trim();
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  const parsed = JSON.parse((s >= 0 && e > s) ? raw.slice(s, e + 1).replace(/\r?\n/g, ' ') : raw);
  return {
    title: String(parsed.title || '').trim().slice(0, 100),
    description: String(parsed.description || '').trim().slice(0, 500),
    board: PIN_BOARDS.includes(parsed.board) ? parsed.board : 'Everyday Faux Florals',
    alt_text: String(parsed.alt_text || '').trim().slice(0, 500)
  };
}

// One call drafts both the Instagram caption and the Facebook post for a piece.
async function mktDraftSocial(p, img, ctx = {}) {
  const prev = ctx.previous || {};
  const textPrompt = `${PIN_VOICE_RULES}
${SOCIAL_VOICE_RULES}
${mktAngleLines(ctx.theme, [], '')}
${(prev.Instagram || []).length ? mktAngleLines('', prev.Instagram, 'Instagram caption') : ''}
${(prev.Facebook || []).length ? mktAngleLines('', prev.Facebook, 'Facebook post') : ''}

Write an Instagram caption and a Facebook post for this product.
- instagram: 2–4 short sentences, under 600 characters before any hashtags. What it is, the standout details, where it looks best. End with a soft call to action like "Shop this one-of-a-kind piece at the link in bio."
- facebook: 2–4 sentences in Patti's own voice, under 600 characters, e.g. what she loved making about it and where it would look at home. Sign off "— Patti".
${img ? 'The product photo is attached — use what you can see.' : ''}

Product title: ${p.title}
Product type: ${p.productType || 'arrangement'}
Tags: ${(p.tags || []).join(', ')}
Product description: ${p.description || ''}

Return ONLY valid JSON, no code fences: {"instagram": "...", "facebook": "..."}`;
  const content = img
    ? [{ type: 'image', source: { type: 'url', url: img.url } }, { type: 'text', text: textPrompt }]
    : textPrompt;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 900, messages: [{ role: 'user', content }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || 'Anthropic API error');
  const raw = (data.content && data.content[0] && data.content[0].text || '').trim();
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  const parsed = JSON.parse((s >= 0 && e > s) ? raw.slice(s, e + 1).replace(/\r?\n/g, ' ') : raw);
  return {
    instagram: String(parsed.instagram || '').trim().slice(0, 2200),
    facebook: String(parsed.facebook || '').trim().slice(0, 2000)
  };
}

// Draft posts. Nothing is posted; rows land as Draft. `count` is the number of pieces.
//   mode 'auto'     — the button and the weekly run: never-posted pieces first (in-season ones
//                     ahead), then reposts of in-season pieces whose last post is oldest.
//   theme           — only pieces tagged for that theme, never-posted first, then oldest post.
//   mode 'surprise' — random pieces that are due.
//   skus            — Patti's picks: drafted on every chosen channel with nothing open, even
//                     inside the cooldown.
// opts.theme also sets the angle; '' means no angle, undefined means the in-season default.
async function mktDraftBatch(count, opts = {}) {
  const [queue, products] = await Promise.all([mktRecords(), mktShopifyCandidates(), invEnsure()]);
  const hist = mktHistory(queue), nowD = new Date(), nowMs = nowD.getTime();
  const chans = (Array.isArray(opts.channels) && opts.channels.length ? opts.channels : MKT_CHANNELS).filter(ch => MKT_CHANNELS.includes(ch));
  const h = (sku, ch) => (hist[sku] || {})[ch];
  const due = (sku, ch) => !h(sku, ch) || (!h(sku, ch).open && nowMs - h(sku, ch).last >= MKT_COOLDOWN_MS);
  const cands = products
    .map(p => ({ p, sku: String((p.variants.nodes[0] || {}).sku || '').trim(), img: mktPickImage(p), video: mktPickVideo(p) }))
    .filter(c => c.sku && c.img && c.p.onlineStoreUrl);
  let eligible;
  if (Array.isArray(opts.skus) && opts.skus.length) {
    eligible = cands.filter(c => opts.skus.includes(c.sku)).map(c => ({ ...c, channels: chans.filter(ch => !(h(c.sku, ch) || {}).open) }));
  } else {
    let list = cands.map(c => ({ ...c, channels: chans.filter(ch => due(c.sku, ch)) })).filter(c => c.channels.length);
    const theme = opts.theme ? mktTheme(opts.theme) : null;
    if (theme) list = list.filter(c => theme.tags.test(mktTagText(c.p)));
    const fresh = list.filter(c => !mktEverPosted(hist, c.sku)), seen = list.filter(c => mktEverPosted(hist, c.sku));
    const byOldest = (a, b) => mktLastPosted(hist, a.sku) - mktLastPosted(hist, b.sku);
    if (opts.mode === 'surprise') list = list.map(c => ({ c, k: Math.random() })).sort((a, b) => a.k - b.k).map(x => x.c);
    else if (theme) list = [...fresh.sort(() => Math.random() - 0.5), ...seen.sort(byOldest)];
    else list = [
      ...fresh.map(c => ({ ...c, score: mktSeasonScore(c.p, nowD) + Math.random() })).sort((a, b) => b.score - a.score),
      ...seen.filter(c => mktAutoTheme(c.p, nowD)).sort(byOldest)
    ];
    eligible = list;
  }
  eligible = eligible.filter(c => c.channels.length);
  const pool = eligible.slice(0, count);
  const created = [], failed = [];
  for (const c of pool) {
    try {
      const inv = invFindBySku(c.sku)[0];
      const now = new Date().toISOString();
      const theme = opts.theme !== undefined ? opts.theme : mktAutoTheme(c.p, nowD);
      const prev = ch => ((h(c.sku, ch) || {}).posts || []).slice(0, 2).map(f => f['Description']);
      const base = {
        'EB Number': c.sku, 'Status': 'Draft', 'Product URL': c.p.onlineStoreUrl, 'Image URL': c.img.url,
        'Similar URL': mktSimilarUrl(c.p), 'Media': c.video ? 'Video' : 'Photo', 'Drafted': now, 'Status changed': now, 'Theme': theme || ''
      };
      if (c.video) base['Video URL'] = c.video;
      if (inv) base['Inventory'] = [inv.id];
      const type = ch => ((h(c.sku, ch) || {}).posts || []).length ? 'Repost' : 'New';
      if (c.channels.includes('Pinterest')) {
        const pin = await mktDraftPin(c.p, c.img, { theme, previous: ((h(c.sku, 'Pinterest') || {}).posts || []).slice(0, 2).map(f => (f['Pin Title'] || '') + ' — ' + (f['Description'] || '')) });
        created.push({ fields: { ...base, 'Channel': 'Pinterest', 'Post type': type('Pinterest'), 'Pin Title': pin.title, 'Description': pin.description, 'Board': pin.board, 'Alt Text': pin.alt_text } });
      }
      if (c.channels.includes('Instagram') || c.channels.includes('Facebook')) {
        const social = await mktDraftSocial(c.p, c.img, { theme, previous: { Instagram: prev('Instagram'), Facebook: prev('Facebook') } });
        if (c.channels.includes('Instagram')) created.push({ fields: { ...base, 'Channel': 'Instagram', 'Post type': type('Instagram'), 'Pin Title': c.p.title, 'Description': social.instagram } });
        if (c.channels.includes('Facebook')) created.push({ fields: { ...base, 'Channel': 'Facebook', 'Post type': type('Facebook'), 'Pin Title': c.p.title, 'Description': social.facebook + '\n\n' + c.p.onlineStoreUrl } });
      }
    } catch (e) { failed.push({ sku: c.sku, error: e.message }); }
  }
  const records = [];
  for (let i = 0; i < created.length; i += 10) {
    const data = await airtableReq(AT_MARKETING_TBL, { method: 'POST', body: JSON.stringify({ records: created.slice(i, i + 10), typecast: true }) });
    records.push(...(data.records || []));
  }
  mktCacheUpsert(records);
  records.filter(r => cutWanted(r.fields || {})).forEach(r => cutForRow(r.fields)); // ready by review time
  return { records, failed, remaining: eligible.length - pool.length };
}

// Weekly drafts without anyone tapping a button. Render's free tier sleeps, so instead of a
// timer this rides on the app's daily open: the queue read kicks off a background batch when
// nothing was drafted in the last 7 days and fewer than 5 drafts are waiting. The same pass
// re-points pins for pieces that sold through a path that didn't call mktHandleSold.
const MKT_AUTO_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const MKT_AUTO_BATCH = 5;
let mktAutoBusy = false, mktSweepAt = 0;
function mktMaybeAutoRun(records) {
  if (PINTEREST_APP_SECRET || PINTEREST_ACCESS_TOKEN || META_APP_SECRET) Promise.all([pinLoadAuth(), metaLoadAuth()]).then(() => mktPostPending(records, { skipErrored: true })).catch(e => console.warn('marketing: posting approved posts failed —', e.message));
  if (mktAutoBusy || !shopifyAccessToken || !ANTHROPIC_API_KEY) return;
  const lastDrafted = Math.max(0, ...records.map(r => Date.parse((r.fields || {})['Drafted'] || '') || 0));
  const waiting = new Set(records.filter(r => (r.fields || {})['Status'] === 'Draft').map(r => r.fields['EB Number'])).size;
  const draftDue = Date.now() - lastDrafted > MKT_AUTO_EVERY_MS && waiting < MKT_AUTO_BATCH;
  const sweepDue = Date.now() - mktSweepAt > 24 * 60 * 60 * 1000;
  if (!draftDue && !sweepDue) return;
  mktAutoBusy = true;
  (async () => {
    if (sweepDue) { mktSweepAt = Date.now(); await mktSoldSweep(); }
    if (draftDue) {
      const out = await mktDraftBatch(MKT_AUTO_BATCH);
      console.log(`marketing: weekly auto-draft created ${out.records.length} draft(s)` + (out.failed.length ? `, ${out.failed.length} failed` : ''));
    }
  })().catch(e => console.warn('marketing: auto run failed —', e.message)).finally(() => { mktAutoBusy = false; });
}

// GET /marketing/queue — every queue row, newest draft first.
app.get('/marketing/queue', async (req, res) => {
  try {
    const records = await mktRecords({ force: req.query.refresh === '1' });
    mktMaybeAutoRun(records);
    res.json({ records, autoDrafting: mktAutoBusy });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /marketing/draft-pins { count } — draft a batch now (the Marketing screen's button).
app.post('/marketing/draft-pins', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized — visit /auth' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });
  const b = req.body || {};
  const count = Math.max(1, Math.min(10, parseInt(b.count || 5, 10) || 5));
  const opts = { mode: b.mode === 'surprise' ? 'surprise' : 'auto' };
  if (typeof b.theme === 'string') { if (b.theme && !mktTheme(b.theme)) return res.status(400).json({ error: 'unknown theme: ' + b.theme }); opts.theme = b.theme; }
  if (Array.isArray(b.skus)) opts.skus = b.skus.map(String).slice(0, 10);
  if (Array.isArray(b.channels)) opts.channels = b.channels;
  // One batch at a time — the weekly run and the button would otherwise draft the same pieces.
  if (mktAutoBusy) return res.status(409).json({ error: 'Posts are already being drafted — check back in a minute.' });
  mktAutoBusy = true;
  try { res.json({ success: true, ...(await mktDraftBatch(opts.skus ? opts.skus.length : count, opts)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
  finally { mktAutoBusy = false; }
});

// GET /marketing/plan — what the "Plan posts" section needs: the seasonal calendar with counts,
// every in-stock piece with its themes and per-channel history, and the themes Patti can pick.
app.get('/marketing/plan', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Shopify not authorized — visit /auth' });
  try {
    const [queue, products] = await Promise.all([mktRecords(), mktShopifyCandidates()]);
    const hist = mktHistory(queue), now = Date.now();
    const pieces = products.map(p => {
      const sku = String((p.variants.nodes[0] || {}).sku || '').trim(), img = mktPickImage(p), tags = mktTagText(p);
      if (!sku || !img || !p.onlineStoreUrl) return null;
      const channels = {};
      for (const ch of MKT_CHANNELS) {
        const x = (hist[sku] || {})[ch];
        channels[ch] = { posts: x ? x.posts.length : 0, lastPosted: x && x.posts[0] ? x.posts[0]['Status changed'] : null, open: !!(x && x.open), due: !x || (!x.open && now - x.last >= MKT_COOLDOWN_MS) };
      }
      return { sku, title: p.title, type: p.productType || '', image: img.url, url: p.onlineStoreUrl, themes: MKT_ALL_THEMES.filter(t => t.tags.test(tags)).map(t => t.name), channels, everPosted: mktEverPosted(hist, sku) };
    }).filter(Boolean);
    const calendar = mktCalendar(new Date()).map(c => {
      const mine = pieces.filter(x => x.themes.includes(c.name));
      return { ...c, pieces: mine.length, neverPosted: mine.filter(x => !x.everPosted).length, due: mine.filter(x => x.everPosted && Object.values(x.channels).some(ch => ch.due)).length };
    });
    res.json({ calendar, themes: MKT_ALL_THEMES.map(t => t.name), cooldownDays: MKT_COOLDOWN_MS / MKT_DAY_MS, pieces });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /marketing/queue/:id { fields } — edit a draft or move it along Draft → Approved → Posted / Skipped.
app.patch('/marketing/queue/:id', async (req, res) => {
  const src = (req.body && req.body.fields) || {};
  const fields = {};
  for (const k of MKT_EDITABLE_FIELDS) if (k in src) fields[k] = src[k];
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'no editable fields given' });
  if ('Status' in fields) {
    if (!MKT_STATUSES.includes(fields['Status'])) return res.status(400).json({ error: 'unknown Status: ' + fields['Status'] });
    fields['Status changed'] = new Date().toISOString();
  }
  try {
    // Approving books the channel's next free daily slot unless a time came with it ("Post now"
    // sends the current time). Leaving Approved clears the slot.
    if (fields['Status'] === 'Approved' && !fields['Scheduled for']) {
      const records = await mktRecords();
      const rec = records.find(r => r.id === req.params.id);
      fields['Scheduled for'] = mktNextSlot(mktChannel(rec && rec.fields), records.filter(r => r.id !== req.params.id)).toISOString();
    } else if ('Status' in fields && fields['Status'] !== 'Approved') fields['Scheduled for'] = null;
    const data = await airtableReq(`${AT_MARKETING_TBL}/${req.params.id}`, { method: 'PATCH', body: JSON.stringify({ fields, typecast: true }) });
    mktCacheUpsert([data]);
    // Approving is the go-ahead: once its channel is connected the post goes out by itself.
    if (data.fields['Status'] === 'Approved' && mktIsDue(data.fields) && mktChannelReady(mktChannel(data.fields))) mktPostPin(req.params.id);
    // Otherwise brand the photo now, so it's ready (and previewable) before its slot.
    else if (data.fields['Status'] === 'Approved') mktBrandRow(data.fields).catch(() => {});
    if ((data.fields['Status'] === 'Draft' || data.fields['Status'] === 'Approved') && cutWanted(data.fields)) cutForRow(data.fields);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /marketing/queue/:id/post — retry posting an approved row after an error.
app.post('/marketing/queue/:id/post', async (req, res) => {
  const rec = (await mktRecords().catch(() => [])).find(r => r.id === req.params.id);
  const channel = mktChannel(rec && rec.fields);
  if (!mktChannelReady(channel)) return res.status(409).json({ error: `${channel} is not connected yet.` });
  mktPostPin(req.params.id);
  res.status(202).json({ success: true, posting: true });
});

// ── Pinterest connection (phase 2) ────────────────────────────
// OAuth once at /pinterest-auth. Pinterest rotates refresh tokens, so a one-time paste
// into Render (the Shopify/Drive pattern) would go stale. The tokens are saved instead
// in the Airtable "Server State" table, AES-256-GCM encrypted with a key derived from
// PINTEREST_APP_SECRET, so they survive restarts and are unreadable in Airtable.
const PINTEREST_APP_ID     = process.env.PINTEREST_APP_ID;
const PINTEREST_APP_SECRET = process.env.PINTEREST_APP_SECRET;
// Trial-access apps may only be allowed to write to Pinterest's sandbox; set
// PINTEREST_API_BASE=https://api-sandbox.pinterest.com/v5 in Render to test there.
const PINTEREST_API_BASE = (process.env.PINTEREST_API_BASE || 'https://api.pinterest.com/v5').replace(/\/$/, '');
const PINTEREST_SCOPES = 'boards:read,boards:write,pins:read,pins:write,user_accounts:read';
// Testing (e.g. a Sandbox token while the app is on Trial access): an access token generated in
// Pinterest's developer portal can be set as PINTEREST_ACCESS_TOKEN. When set it wins over the
// saved OAuth connection and is used as is (no refresh, nothing saved); a token only works in
// its own environment, so pair a Sandbox token with the sandbox PINTEREST_API_BASE. Remove it
// to go back to the /pinterest-auth connection.
// Tokens pasted into Render often carry a line break, spaces or a leading "Bearer", which Node
// rejects in a header ("Invalid character in header content"); keep only the token itself.
const PINTEREST_ACCESS_TOKEN = (process.env.PINTEREST_ACCESS_TOKEN || '').replace(/^\s*bearer\s+/i, '').replace(/\s+/g, '') || undefined;
// While a test token handles the API calls, /pinterest-auth still exchanges its code with the live
// API, so the saved connection is a real one that takes over as soon as the token is removed.
const PINTEREST_OAUTH_BASE = PINTEREST_ACCESS_TOKEN ? 'https://api.pinterest.com/v5' : PINTEREST_API_BASE;
const AT_STATE_TBL = 'tbljykqkWi9metp4c';
const PIN_STATE_KEY = 'pinterest_auth';
const pinAuth = { loaded: false, accessToken: null, refreshToken: null, expiresAt: 0, username: null };
const pinOauthStates = new Map(); // state → issued-at, for CSRF protection on the callback

// AES-256-GCM for connection tokens saved in Server State (Pinterest and Meta each use a key
// derived from their own app secret).
function stateEncrypt(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function stateDecrypt(s, key) {
  const b = Buffer.from(String(s).replace(/^enc:/, ''), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}
function pinCipherKey() { return crypto.createHash('sha256').update('eb-pinterest-auth:' + PINTEREST_APP_SECRET).digest(); }
function pinEncrypt(obj) { return stateEncrypt(obj, pinCipherKey()); }
function pinDecrypt(s) { return stateDecrypt(s, pinCipherKey()); }
function pinOauthConnected() { return !!(PINTEREST_APP_SECRET && (pinAuth.refreshToken || pinAuth.accessToken)); }
function pinConnected() { return pinOauthConnected() || !!PINTEREST_ACCESS_TOKEN; }

async function pinLoadAuth() {
  if (pinAuth.loaded || !PINTEREST_APP_SECRET) return;
  const data = await airtableReq(`${AT_STATE_TBL}?maxRecords=1&filterByFormula=${encodeURIComponent(`{Key}='${PIN_STATE_KEY}'`)}`, { source: 'pinterest:load' });
  const rec = (data.records || [])[0];
  if (rec && rec.fields['Value']) {
    try { Object.assign(pinAuth, pinDecrypt(rec.fields['Value'])); }
    catch (e) { console.warn('Pinterest: saved connection could not be decrypted (app secret changed?) — reconnect at /pinterest-auth'); }
  }
  pinAuth.loaded = true;
}
async function pinSaveAuth() {
  const { accessToken, refreshToken, expiresAt, username } = pinAuth;
  await airtableReq(AT_STATE_TBL, { method: 'PATCH', source: 'pinterest:save', body: JSON.stringify({
    performUpsert: { fieldsToMergeOn: ['Key'] },
    records: [{ fields: { 'Key': PIN_STATE_KEY, 'Value': pinEncrypt({ accessToken, refreshToken, expiresAt, username }), 'Updated': new Date().toISOString() } }]
  }) });
}
async function pinTokenRequest(params) {
  const r = await fetch(`${PINTEREST_OAUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + Buffer.from(`${PINTEREST_APP_ID}:${PINTEREST_APP_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Pinterest token error: ' + (d.message || JSON.stringify(d)));
  pinAuth.accessToken = d.access_token;
  if (d.refresh_token) pinAuth.refreshToken = d.refresh_token;
  pinAuth.expiresAt = Date.now() + (d.expires_in || 2592000) * 1000;
}
// A valid access token, refreshed when it's within a day of expiring.
async function pinAccessToken() {
  await pinLoadAuth();
  if (PINTEREST_ACCESS_TOKEN) return PINTEREST_ACCESS_TOKEN;
  if (!pinConnected()) throw new Error('Pinterest is not connected — visit /pinterest-auth');
  if (!pinAuth.accessToken || Date.now() > pinAuth.expiresAt - 24 * 60 * 60 * 1000) {
    await pinTokenRequest({ grant_type: 'refresh_token', refresh_token: pinAuth.refreshToken });
    await pinSaveAuth();
  }
  return pinAuth.accessToken;
}
async function pinApi(path, opts = {}) {
  const r = await fetch(PINTEREST_API_BASE + path, {
    method: opts.method || 'GET',
    headers: { 'Authorization': 'Bearer ' + await pinAccessToken(), 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Pinterest ${opts.method || 'GET'} ${path} failed (${r.status}): ${d.message || JSON.stringify(d)}`);
  return d;
}

const PIN_PAGE = (title, body) => `<html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Poppins:wght@300;400;500&display=swap" rel="stylesheet"><style>body{font-family:'Poppins',system-ui,sans-serif;background:#fbfaf9;color:#2b2622;padding:48px 40px;max-width:560px;margin:0 auto;line-height:1.7}h2{font-family:'DM Serif Display',Georgia,serif;font-weight:400;color:#bb8588;font-size:28px;margin-bottom:10px}p{color:#5b5248;font-size:14px}</style></head><body><h2>${title}</h2>${body}</body></html>`;

app.get('/pinterest-auth', (req, res) => {
  if (!PINTEREST_APP_ID || !PINTEREST_APP_SECRET) return res.status(500).send(PIN_PAGE('Pinterest isn’t set up yet', '<p>Add PINTEREST_APP_ID and PINTEREST_APP_SECRET to the server’s environment in Render, then try again.</p>'));
  const state = crypto.randomBytes(16).toString('hex');
  pinOauthStates.set(state, Date.now());
  const authUrl = 'https://www.pinterest.com/oauth/?client_id=' + encodeURIComponent(PINTEREST_APP_ID)
    + '&redirect_uri=' + encodeURIComponent(`${SERVER_URL}/pinterest-auth/callback`)
    + '&response_type=code&scope=' + encodeURIComponent(PINTEREST_SCOPES) + '&state=' + state;
  res.redirect(authUrl);
});

app.get('/pinterest-auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(PIN_PAGE('Pinterest didn’t connect', `<p>Pinterest said: ${String(error).replace(/[<>&]/g, '')}. Close this tab and try Connect Pinterest again.</p>`));
  const issued = pinOauthStates.get(state);
  pinOauthStates.delete(state);
  if (!issued || Date.now() - issued > 15 * 60 * 1000) return res.status(400).send(PIN_PAGE('Link expired', '<p>This connect link is old or was already used. Close this tab and tap Connect Pinterest again.</p>'));
  try {
    await pinTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: `${SERVER_URL}/pinterest-auth/callback`, continuous_refresh: 'true' });
    pinAuth.loaded = true;
    const me = await pinApi('/user_account');
    pinAuth.username = me.username || null;
    await pinSaveAuth();
    console.log(`✓ Pinterest connected as @${pinAuth.username}`);
    // Pins approved while Pinterest wasn't connected go out now.
    mktRecords().then(records => mktPostPending(records)).catch(e => console.warn('marketing: posting approved pins failed —', e.message));
    res.send(PIN_PAGE('✓ Pinterest connected', `<p>EB Master can now post approved pins to <strong>@${pinAuth.username || 'your account'}</strong>. This stays connected across server restarts — nothing to copy into Render.</p><p>You can close this tab and return to the Studio.</p>`));
  } catch (e) { res.status(500).send(PIN_PAGE('Pinterest didn’t connect', `<p>${String(e.message).replace(/[<>&]/g, '')}</p>`)); }
});

// GET /pinterest/status — what the Marketing screen shows about the connection.
app.get('/pinterest/status', async (req, res) => {
  try { await pinLoadAuth(); } catch (e) { /* Airtable hiccup: report what we know */ }
  const tokenOnly = !!PINTEREST_ACCESS_TOKEN;
  // A portal token has no saved username; look it up once (needs user_accounts:read).
  if (tokenOnly && !pinAuth.username) { try { pinAuth.username = (await pinApi('/user_account')).username || null; } catch (e) { /* scope missing: show without a name */ } }
  res.json({ configured: !!(PINTEREST_APP_ID && PINTEREST_APP_SECRET) || !!PINTEREST_ACCESS_TOKEN, connected: pinConnected(), username: pinAuth.username, sandbox: /sandbox/.test(PINTEREST_API_BASE), testToken: tokenOnly });
});

// Boards are created the first time a pin needs them, so the profile never shows empty boards.
const PIN_BOARD_DESCRIPTION = name => `${name}: handcrafted, one-of-a-kind faux floral arrangements by Eternal Blooms by Patti. Florals that bloom forever.`;
let pinBoards = null; // name (lowercase) → board id
async function pinLoadBoards() {
  pinBoards = new Map(); let bookmark = null;
  do {
    const d = await pinApi('/boards?page_size=100' + (bookmark ? '&bookmark=' + encodeURIComponent(bookmark) : ''));
    for (const b of (d.items || [])) pinBoards.set(String(b.name).toLowerCase(), b.id);
    bookmark = d.bookmark || null;
  } while (bookmark);
}
async function pinCreateBoard(name) {
  const b = await pinApi('/boards', { method: 'POST', body: { name, description: PIN_BOARD_DESCRIPTION(name), privacy: 'PUBLIC' } });
  pinBoards.set(String(name).toLowerCase(), b.id);
  return b.id;
}
async function pinBoardId(name) {
  if (!pinBoards) await pinLoadBoards();
  const key = String(name).toLowerCase();
  if (!pinBoards.has(key)) {
    try {
      await pinCreateBoard(name);
    } catch (e) {
      // "You already have a board with this name": the list may be stale, so reload it. The
      // Sandbox lists only Sandbox boards but checks names against the real profile, so there a
      // test board gets its own name instead.
      if (/already have a board/i.test(e.message)) {
        await pinLoadBoards();
        if (pinBoards.has(key)) return pinBoards.get(key);
        if (/sandbox/.test(PINTEREST_API_BASE)) {
          const test = `${name} (sandbox)`;
          return pinBoards.get(test.toLowerCase()) || await pinCreateBoard(test);
        }
      }
      // A token without boards:write can't make boards: pin to an existing one rather than fail.
      const fallback = pinBoards.get('everyday faux florals') || pinBoards.values().next().value;
      if (!fallback) throw e;
      console.warn(`Pinterest: couldn't create board "${name}" (${e.message}) — pinning to an existing board instead`);
      return fallback;
    }
  }
  return pinBoards.get(key);
}

// Upload a Shopify video to Pinterest and wait until it's processed. The MP4 is streamed
// straight from Shopify's CDN into Pinterest's upload target (same form-data pattern as
// /shopify-add-video), so memory stays flat whatever the file size.
async function pinUploadVideo(videoUrl) {
  const reg = await pinApi('/media', { method: 'POST', body: { media_type: 'video' } });
  const vres = await fetch(videoUrl);
  if (!vres.ok) throw new Error('Video download from Shopify failed: ' + vres.status);
  if (!Number(vres.headers.get('content-length'))) throw new Error('Shopify did not report the video size');
  const form = new FormData();
  for (const [k, v] of Object.entries(reg.upload_parameters || {})) form.append(k, v);
  form.append('file', vres.body, { knownLength: Number(vres.headers.get('content-length')), contentType: 'video/mp4', filename: 'pin.mp4' });
  await new Promise((resolve, reject) => {
    form.submit(reg.upload_url, (err, up) => {
      if (err) return reject(err);
      let errText = '';
      up.on('data', c => { if (up.statusCode >= 300 && errText.length < 300) errText += c.toString(); });
      up.on('end', () => up.statusCode < 300 ? resolve() : reject(new Error(`Pinterest video upload failed (${up.statusCode}): ${errText.slice(0, 300)}`)));
      up.on('error', reject);
    });
  });
  for (let i = 0; i < 60; i++) { // up to ~5 minutes
    await new Promise(r => setTimeout(r, 5000));
    const m = await pinApi('/media/' + reg.media_id);
    if (m.status === 'succeeded') return reg.media_id;
    if (m.status === 'failed') throw new Error('Pinterest could not process the video');
  }
  throw new Error('Pinterest is still processing the video — tap Retry in a few minutes');
}

// ── Meta connection: the Facebook Page and its linked Instagram business account ──
// OAuth once at /meta-auth. The long-lived user token is exchanged for the Page's own token,
// which doesn't expire, so unlike Pinterest there's nothing to refresh. Saved the same way:
// encrypted in the Airtable "Server State" table with a key derived from META_APP_SECRET.
const META_APP_ID     = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_GRAPH       = 'https://graph.facebook.com/' + (process.env.META_GRAPH_VERSION || 'v23.0');
const META_GRAPH_VIDEO = META_GRAPH.replace('//graph.', '//graph-video.');
const META_SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish,business_management';
// The app uses Facebook Login for Business, which logs in with a saved configuration (made in the
// app's Facebook Login for Business → Configurations, with the permissions above) rather than a
// scope list. When META_CONFIG_ID is set the connect link sends it instead of the scopes.
const META_CONFIG_ID = process.env.META_CONFIG_ID;
const META_STATE_KEY = 'meta_auth';
const metaAuth = { loaded: false, pageId: null, pageName: null, pageToken: null, igId: null, igUsername: null };
const metaOauthStates = new Map(); // state → issued-at, for CSRF protection on the callback

function metaCipherKey() { return crypto.createHash('sha256').update('eb-meta-auth:' + META_APP_SECRET).digest(); }
function metaConnected() { return !!(META_APP_SECRET && metaAuth.pageToken); }
async function metaLoadAuth() {
  if (metaAuth.loaded || !META_APP_SECRET) return;
  const data = await airtableReq(`${AT_STATE_TBL}?maxRecords=1&filterByFormula=${encodeURIComponent(`{Key}='${META_STATE_KEY}'`)}`, { source: 'meta:load' });
  const rec = (data.records || [])[0];
  if (rec && rec.fields['Value']) {
    try { Object.assign(metaAuth, stateDecrypt(rec.fields['Value'], metaCipherKey())); }
    catch (e) { console.warn('Meta: saved connection could not be decrypted (app secret changed?) — reconnect at /meta-auth'); }
  }
  metaAuth.loaded = true;
}
async function metaSaveAuth() {
  const { pageId, pageName, pageToken, igId, igUsername } = metaAuth;
  await airtableReq(AT_STATE_TBL, { method: 'PATCH', source: 'meta:save', body: JSON.stringify({
    performUpsert: { fieldsToMergeOn: ['Key'] },
    records: [{ fields: { 'Key': META_STATE_KEY, 'Value': stateEncrypt({ pageId, pageName, pageToken, igId, igUsername }, metaCipherKey()), 'Updated': new Date().toISOString() } }]
  }) });
}
// Graph API call. GET params go in the query string, POST params form-encoded. Video uploads
// to a Page go to the graph-video host.
async function metaApi(path, { method = 'GET', params = {}, video = false } = {}) {
  const url = (video ? META_GRAPH_VIDEO : META_GRAPH) + path, qs = new URLSearchParams(params);
  const r = method === 'GET' ? await fetch(url + '?' + qs)
    : await fetch(url, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(`Meta ${method} ${path} failed (${r.status}): ${(d.error && d.error.message) || JSON.stringify(d)}`);
  return d;
}

app.get('/meta-auth', (req, res) => {
  if (!META_APP_ID || !META_APP_SECRET) return res.status(500).send(PIN_PAGE('Facebook & Instagram aren’t set up yet', '<p>Add META_APP_ID and META_APP_SECRET to the server’s environment in Render, then try again.</p>'));
  const state = crypto.randomBytes(16).toString('hex');
  metaOauthStates.set(state, Date.now());
  res.redirect(META_GRAPH.replace('//graph.', '//www.') + '/dialog/oauth?client_id=' + encodeURIComponent(META_APP_ID)
    + '&redirect_uri=' + encodeURIComponent(`${SERVER_URL}/meta-auth/callback`)
    + '&response_type=code' + (META_CONFIG_ID ? '&config_id=' + encodeURIComponent(META_CONFIG_ID) : '&scope=' + encodeURIComponent(META_SCOPES))
    + '&state=' + state);
});

app.get('/meta-auth/callback', async (req, res) => {
  const { code, state, error_description } = req.query;
  if (!code) return res.status(400).send(PIN_PAGE('Facebook didn’t connect', `<p>${String(error_description || 'No authorization code came back.').replace(/[<>&]/g, '')} Close this tab and try Connect Facebook & Instagram again.</p>`));
  const issued = metaOauthStates.get(state);
  metaOauthStates.delete(state);
  if (!issued || Date.now() - issued > 15 * 60 * 1000) return res.status(400).send(PIN_PAGE('Link expired', '<p>This connect link is old or was already used. Close this tab and tap Connect Facebook & Instagram again.</p>'));
  try {
    const redirect_uri = `${SERVER_URL}/meta-auth/callback`;
    const short = await metaApi('/oauth/access_token', { params: { client_id: META_APP_ID, client_secret: META_APP_SECRET, redirect_uri, code } });
    const long = await metaApi('/oauth/access_token', { params: { grant_type: 'fb_exchange_token', client_id: META_APP_ID, client_secret: META_APP_SECRET, fb_exchange_token: short.access_token } });
    const pages = (await metaApi('/me/accounts', { params: { fields: 'id,name,access_token,instagram_business_account{id,username}', access_token: long.access_token } })).data || [];
    // META_PAGE_ID picks the Page when the account manages several; otherwise the one with Instagram.
    const page = pages.find(p => p.id === process.env.META_PAGE_ID) || pages.find(p => p.instagram_business_account) || pages[0];
    if (!page) throw new Error('No Facebook Page came back. Connect again and tick the Eternal Blooms Page when Facebook asks which Pages to share.');
    const ig = page.instagram_business_account || {};
    Object.assign(metaAuth, { loaded: true, pageId: page.id, pageName: page.name, pageToken: page.access_token, igId: ig.id || null, igUsername: ig.username || null });
    await metaSaveAuth();
    console.log(`✓ Meta connected: Page "${page.name}"` + (ig.id ? `, Instagram @${ig.username}` : ' (no Instagram account linked)'));
    // Posts approved while Facebook & Instagram weren't connected go out now.
    mktRecords().then(records => mktPostPending(records)).catch(e => console.warn('marketing: posting approved posts failed —', e.message));
    res.send(PIN_PAGE('✓ Facebook & Instagram connected', `<p>EB Master can now post approved posts to the Facebook Page <strong>${String(page.name).replace(/[<>&]/g, '')}</strong>`
      + (ig.id ? ` and Instagram <strong>@${String(ig.username).replace(/[<>&]/g, '')}</strong>.` : '. <strong>No Instagram account is linked to this Page</strong> — link it in the Page’s settings, then connect again.')
      + ' This stays connected across server restarts — nothing to copy into Render.</p><p>You can close this tab and return to the Studio.</p>'));
  } catch (e) { res.status(500).send(PIN_PAGE('Facebook didn’t connect', `<p>${String(e.message).replace(/[<>&]/g, '')}</p>`)); }
});

// GET /meta/status — what the Marketing screen shows about the Facebook & Instagram connection.
app.get('/meta/status', async (req, res) => {
  try { await metaLoadAuth(); } catch (e) { /* Airtable hiccup: report what we know */ }
  // Instagram captions say "link in bio", so show where that link goes.
  let igWebsite = null;
  if (metaConnected() && metaAuth.igId) igWebsite = (await metaApi('/' + metaAuth.igId, { params: { fields: 'website', access_token: metaAuth.pageToken } }).catch(() => ({}))).website || null;
  res.json({ configured: !!(META_APP_ID && META_APP_SECRET), connected: metaConnected(), pageName: metaAuth.pageName, igUsername: metaAuth.igUsername, instagram: !!metaAuth.igId, igWebsite });
});

// ── Logo on posted photos ──
// Every photo that goes out carries the white Eternal Blooms logo. Some listing photos already
// have it, so per queue row the Logo field decides: blank/Auto = Claude looks at the photo and
// the logo is added only when it isn't there yet; "Add logo" always adds it; "Already has logo"
// posts the photo untouched. Videos post exactly as they are on Shopify.
// Branded copies are made with ffmpeg and kept on this server's disk; the channels fetch them from
// /marketing/media/<file> while posting (the Shopify app has no write_files scope). The disk is
// wiped on restart, so a missing copy is simply made again. Copies are named by a hash of their
// source, so a piece's photo is made once and shared by all three channels.
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const FFMPEG_PATH = (() => { try { return require('@ffmpeg-installer/ffmpeg').path; } catch (e) { return null; } })();
const BRAND_LOGO = path.join(__dirname, 'assets', 'logo-white.png');
const BRAND_DIR = path.join(os.tmpdir(), 'eb-branded');
const BRAND_VERSION = 1; // bump when the placement changes so old copies are remade
const BRAND_KEEP_MS = 3 * MKT_DAY_MS;
// Logo width as a share of the photo, and where its bottom edge sits as a share of the height.
const BRAND_PLACE = { w: 0.8, bottom: 0.97 };
const BRAND_LOGO_SIZE = (() => { try { const b = fs.readFileSync(BRAND_LOGO); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; } catch (e) { return null; } })();
fs.mkdirSync(BRAND_DIR, { recursive: true });

// Runs ffmpeg; resolves with its log. allowFail resolves on a non-zero exit too (ffmpeg -i
// with no output "fails" but prints the size we want).
function ffmpeg(args, { allowFail = false, timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG_PATH) return reject(new Error('ffmpeg is not installed on the server'));
    const p = spawn(FFMPEG_PATH, ['-hide_banner', '-y', ...args]);
    let log = '';
    p.stderr.on('data', c => { log += c; if (log.length > 40000) log = log.slice(-20000); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || allowFail) return resolve(log);
      reject(new Error('ffmpeg failed: ' + log.trim().split('\n').slice(-2).join(' ').slice(0, 300)));
    });
  });
}
async function brandProbe(file) {
  const log = await ffmpeg(['-i', file], { allowFail: true });
  const size = log.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
  if (!size) throw new Error('could not read the photo size');
  return { w: +size[1], h: +size[2] };
}
async function brandDownload(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    r.body.on('error', reject); out.on('error', reject); out.on('finish', resolve);
    r.body.pipe(out);
  });
}

// Does the photo already carry the logo? Claude looks at a small copy and answers yes/no.
async function brandHasLogo(frame) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const content = [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(frame).toString('base64') } },
    { type: 'text', text: 'This is a product photo. The Eternal Blooms logo is a line drawing of a magnolia flower beside the words "Eternal Blooms" in flowing script, usually white, often across the lower part of the picture. Is that logo, or the words "Eternal Blooms" as a watermark, visible in this image? Answer only YES or NO.' }
  ];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content }] })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || 'Anthropic API error');
  return /^\s*yes/i.test((data.content && data.content[0] && data.content[0].text) || '');
}

// The ffmpeg filter that lays the logo (with a soft shadow for light backgrounds) over a photo
// of the given size.
function brandFilter({ w, h }) {
  const lw = Math.round(w * BRAND_PLACE.w / 2) * 2, lh = Math.round(lw * BRAND_LOGO_SIZE.h / BRAND_LOGO_SIZE.w / 2) * 2;
  const x = Math.round((w - lw) / 2), y = Math.round(h * BRAND_PLACE.bottom - lh);
  const off = Math.max(2, Math.round(w * 0.003)), blur = Math.max(2, Math.round(lh * 0.06));
  return `[1:v]scale=${lw}:${lh},split[lg][lgs];[lgs]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.5,boxblur=${blur}:2[sh];` +
    `[0:v][sh]overlay=${x + off}:${y + off}[b];[b][lg]overlay=${x}:${y}[v]`;
}

const brandSeen = new Map();   // source URL → true when it already carries the logo
const brandJobs = new Map();   // copy file name → in-flight promise, so 3 channels share one job
const brandFailed = new Map(); // copy file name → { error, at }: don't retry a failure on every poll
let brandQueue = Promise.resolve(); // one job at a time: the Render instance is small
const brandName = src => crypto.createHash('sha256').update(`${BRAND_VERSION}|image|${src}`).digest('hex').slice(0, 32) + '.jpg';
const brandUrl = name => `${SERVER_URL}/marketing/media/${name}`;

// The URL to post for a photo: the branded copy, or the source itself.
// Resolves to { url, logo: 'added' | 'already' | 'kept' }.
async function brandMedia(src, mode) {
  if (!src || mode === 'Already has logo') return { url: src, logo: 'kept' };
  const name = brandName(src), file = path.join(BRAND_DIR, name);
  if (fs.existsSync(file)) return { url: brandUrl(name), logo: 'added' };
  if (mode !== 'Add logo' && brandSeen.get(src)) return { url: src, logo: 'already' };
  const failed = brandFailed.get(name);
  if (failed && Date.now() - failed.at < 10 * 60 * 1000) throw new Error(failed.error);
  if (!brandJobs.has(name)) {
    const job = brandQueue.then(() => brandMake(src, mode, name, file));
    brandQueue = job.catch(() => {});
    brandJobs.set(name, job);
    job.catch(e => brandFailed.set(name, { error: e.message, at: Date.now() })).finally(() => brandJobs.delete(name));
  }
  return brandJobs.get(name);
}
async function brandMake(src, mode, name, file) {
  if (!BRAND_LOGO_SIZE) throw new Error('logo file is missing on the server');
  const tag = crypto.randomBytes(6).toString('hex');
  const input = path.join(BRAND_DIR, `in-${tag}.jpg`), tmp = path.join(BRAND_DIR, `out-${tag}.jpg`), frame = path.join(BRAND_DIR, `fr-${tag}.jpg`);
  try {
    await brandDownload(src, input);
    const size = await brandProbe(input);
    if (mode !== 'Add logo') {
      if (!brandSeen.has(src)) {
        await ffmpeg(['-i', input, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '4', frame]);
        brandSeen.set(src, await brandHasLogo(frame));
      }
      if (brandSeen.get(src)) return { url: src, logo: 'already' };
    }
    await ffmpeg(['-i', input, '-i', BRAND_LOGO, '-filter_complex', brandFilter(size), '-map', '[v]', '-frames:v', '1', '-q:v', '2', tmp]);
    fs.renameSync(tmp, file);
    console.log(`branding: photo logo added (${name})`);
    return { url: brandUrl(name), logo: 'added' };
  } finally {
    for (const f of [input, tmp, frame]) fs.rm(f, { force: true }, () => {});
  }
}

// The photo a queue row should post with, per its Logo setting. A branding failure never blocks
// a post: the photo goes out as it is and the reason comes back as a note.
async function mktBrandRow(f) {
  const notes = [];
  const image = await brandMedia(f['Image URL'], f['Logo'] || 'Auto')
    .catch(e => { notes.push(`Photo posted without the logo: ${e.message}`); return { url: f['Image URL'], logo: 'failed' }; });
  return { image: image.url, imageLogo: image.logo, notes };
}

// Old copies are deleted after a few days; the disk is small and copies are cheap to remake.
function brandCleanup() {
  fs.readdir(BRAND_DIR, (err, names) => {
    if (err) return;
    for (const n of names) fs.stat(path.join(BRAND_DIR, n), (e, st) => { if (!e && Date.now() - st.mtimeMs > BRAND_KEEP_MS) fs.rm(path.join(BRAND_DIR, n), { force: true }, () => {}); });
  });
}
brandCleanup();
setInterval(brandCleanup, 6 * 60 * 60 * 1000);

// GET /marketing/media/<file> — a branded photo or social video cut, fetched by
// Pinterest/Instagram/Facebook and shown in EB Master's preview.
app.get('/marketing/media/:name', (req, res) => {
  if (!/^[a-f0-9]{32}\.(jpg|mp4)$/.test(req.params.name)) return res.status(404).end();
  const file = path.join(BRAND_DIR, req.params.name);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file, { maxAge: '1d' });
});

// GET /marketing/brand/:id — the photo a row will post with. Starts the branding if needed and
// answers { status: 'working' } until it's done; EB Master polls for the preview.
app.get('/marketing/brand/:id', async (req, res) => {
  const rec = (await mktRecords().catch(() => [])).find(r => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'queue row not found' });
  const job = mktBrandRow(rec.fields);
  const done = await Promise.race([job, new Promise(r => setTimeout(() => r(null), 1500))]);
  res.json(done ? { status: 'ready', ...done } : { status: 'working' });
});

// ── Social video cut ──
// Listing videos post as a 15-second social cut made to the rules Patti approved (2026-10-31;
// the recipe is in lib/social-cut.js). Making one needs far more memory and CPU than this
// instance has (it restarted the server, 2026-10-31), so a GitHub Action makes them every 30
// minutes (scripts/social-cut-worker.js): it asks /marketing/cut-jobs which videos need one and
// sends each cut back to /marketing/cut-upload, with the shared SOCIAL_CUT_KEY. The server keeps
// the cut on disk like the branded photos and saves it to the Drive folder "Video shorts
// optimized for Social Posting"; after a restart it is fetched back from Drive.
// Approved posts wait for their cut (up to CUT_MAX_WAIT_MS); a video with no usable footage, or
// Video version "Original video", posts the Shopify video as it is.
const { cutName } = require('./lib/social-cut');
const CUT_KEY = process.env.SOCIAL_CUT_KEY || '';
const CUT_DRIVE_FOLDER = process.env.SOCIAL_CUT_FOLDER_ID || '10Wsw5PbSjx3GT6_iVoZpa9ajGP0P4RXU';
const CUT_MAX_WAIT_MS = 3 * 60 * 60 * 1000;
const CUT_DRIVE_RECHECK_MS = 10 * 60 * 1000;
const CUT_WAITING = 'waiting for the video maker, which runs every 30 minutes';
const cutJobs = new Map();    // cut file name → { promise, stage }: fetching a saved cut from Drive
const cutFailed = new Map();  // cut file name → { error, at }
const cutDrive = new Map();   // cut file name → Drive file id
const cutChecked = new Map(); // cut file name → when Drive was last checked for it
const cutAuthorized = req => {
  const got = crypto.createHash('sha256').update(String(req.get('x-cut-key') || '')).digest();
  return !!CUT_KEY && crypto.timingSafeEqual(got, crypto.createHash('sha256').update(CUT_KEY).digest());
};

// Drive keeps every cut (for other uses too), named with the full EB number.
async function cutDriveFind(name) {
  if (cutDrive.has(name)) return cutDrive.get(name);
  const q = `'${CUT_DRIVE_FOLDER}' in parents and trashed = false and properties has { key='eb_social_cut' and value='${name}' }`;
  const d = await driveRequest('/files?q=' + encodeURIComponent(q) + '&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true');
  const id = d.files && d.files[0] && d.files[0].id;
  if (id) cutDrive.set(name, id);
  return id || null;
}
async function cutDriveSave(file, name, eb, title) {
  const token = await getValidGoogleToken();
  const fileName = `${eb} ${String(title || '').replace(/[\\/:*?"<>|]/g, '').trim()} - social 15s.mp4`.replace(/\s+/g, ' ');
  const metadata = { name: fileName, parents: [CUT_DRIVE_FOLDER], properties: { eb_number: eb || '', eb_social_cut: name } };
  const boundary = 'ebcut' + Date.now();
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`, 'utf8'),
    fs.readFileSync(file), Buffer.from(`\r\n--${boundary}--`, 'utf8')
  ]);
  const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${boundary}` }, body
  });
  if (!up.ok) throw new Error('Drive upload failed ' + up.status + ': ' + (await up.text().catch(() => '')).slice(0, 200));
  const id = (await up.json()).id;
  cutDrive.set(name, id);
  return id;
}
async function cutDriveFetch(id, file) {
  const token = await getValidGoogleToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: { 'Authorization': 'Bearer ' + token } });
  if (!r.ok) throw new Error(`Drive download failed (${r.status})`);
  const tmp = file + '.part';
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    r.body.on('error', reject); out.on('error', reject); out.on('finish', resolve);
    r.body.pipe(out);
  });
  fs.renameSync(tmp, file);
}

// The social cut for a listing video: { status: 'ready', url }, { status: 'working', stage } or
// { status: 'failed', error }. A cut not on disk is looked for in Drive (at most every 10
// minutes); one not there yet waits for the video maker.
function cutStatus(src) {
  const name = cutName(src), file = path.join(BRAND_DIR, name);
  if (fs.existsSync(file)) return { status: 'ready', url: brandUrl(name) };
  const running = cutJobs.get(name);
  if (running) return { status: 'working', stage: running.stage };
  const failed = cutFailed.get(name);
  if (failed) return { status: 'failed', error: failed.error };
  if (!CUT_KEY) return { status: 'failed', error: '15-second cuts are paused for now' };
  if (Date.now() - (cutChecked.get(name) || 0) > CUT_DRIVE_RECHECK_MS) {
    cutChecked.set(name, Date.now());
    const job = { stage: 'checking Drive for the saved cut' };
    job.promise = cutDriveFind(name).then(id => id && (job.stage = 'fetching the saved cut from Drive', cutDriveFetch(id, file)));
    cutJobs.set(name, job);
    job.promise.catch(e => console.warn('social cut: Drive lookup failed —', e.message)).finally(() => cutJobs.delete(name));
    return { status: 'working', stage: job.stage };
  }
  return { status: 'working', stage: CUT_WAITING };
}
const cutWanted = f => f['Media'] === 'Video' && !!f['Video URL'] && f['Video version'] !== 'Original video';
const cutForRow = f => cutStatus(f['Video URL']);

// GET /marketing/cut/:id — the social cut for a queue row; EB Master polls it for the preview.
app.get('/marketing/cut/:id', async (req, res) => {
  const rec = (await mktRecords().catch(() => [])).find(r => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'queue row not found' });
  const f = rec.fields || {};
  if (f['Media'] !== 'Video' || !f['Video URL']) return res.json({ status: 'none' });
  res.json(cutForRow(f));
});

// GET /marketing/cut-jobs — for the video maker: the listing videos that still need a cut,
// approved posts first (soonest slot first), then drafts (newest first).
app.get('/marketing/cut-jobs', async (req, res) => {
  if (!cutAuthorized(req)) return res.status(403).json({ error: 'not allowed' });
  try {
    const rows = (await mktRecords()).map(r => r.fields || {})
      .filter(f => (f['Status'] === 'Draft' || f['Status'] === 'Approved') && cutWanted(f));
    const rank = f => f['Status'] === 'Approved' ? [0, Date.parse(f['Scheduled for'] || '') || 0] : [1, -(Date.parse(f['Drafted'] || '') || 0)];
    rows.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1]);
    const jobs = [], seen = new Set();
    for (const f of rows) {
      const name = cutName(f['Video URL']);
      if (seen.has(name)) continue;
      seen.add(name);
      if (fs.existsSync(path.join(BRAND_DIR, name)) || cutFailed.has(name)) continue;
      if (await cutDriveFind(name).catch(() => null)) continue; // fetched when its card or post asks
      jobs.push({ name, src: f['Video URL'], eb: f['EB Number'] || '' });
      if (jobs.length >= (+req.query.limit || 8)) break;
    }
    res.json({ jobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /marketing/cut-upload/:name — a finished cut (the MP4 as the body). Kept on disk and
// saved to Drive under the piece's EB number and title.
app.post('/marketing/cut-upload/:name', express.raw({ type: 'video/mp4', limit: '60mb' }), async (req, res) => {
  if (!cutAuthorized(req)) return res.status(403).json({ error: 'not allowed' });
  const name = req.params.name;
  if (!/^[a-f0-9]{32}\.mp4$/.test(name) || !Buffer.isBuffer(req.body) || req.body.length < 10000) return res.status(400).json({ error: 'bad cut' });
  try {
    const f = ((await mktRecords().catch(() => [])).map(r => r.fields || {}).find(x => x['Video URL'] && cutName(x['Video URL']) === name)) || {};
    const file = path.join(BRAND_DIR, name), tmp = file + '.part';
    fs.writeFileSync(tmp, req.body);
    fs.renameSync(tmp, file);
    cutFailed.delete(name);
    console.log(`social cut: received ${name} for ${f['EB Number'] || '?'} (${Math.round(req.body.length / 1e6)} MB)`);
    if (!cutDrive.has(name)) await cutDriveSave(file, name, f['EB Number'] || '', f['Pin Title'] || '')
      .catch(e => console.warn('social cut: not saved to Drive —', e.message));
    res.json({ ok: true, url: brandUrl(name), driveId: cutDrive.get(name) || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /marketing/cut-failed/:name — the video maker found no usable footage; the post goes out
// with the listing video as it is.
app.post('/marketing/cut-failed/:name', (req, res) => {
  if (!cutAuthorized(req)) return res.status(403).json({ error: 'not allowed' });
  if (!/^[a-f0-9]{32}\.mp4$/.test(req.params.name)) return res.status(400).json({ error: 'bad name' });
  cutFailed.set(req.params.name, { error: String((req.body && req.body.error) || 'no usable footage').slice(0, 300), at: Date.now() });
  res.json({ ok: true });
});

function mktChannelReady(channel) {
  if (channel === 'Instagram') return metaConnected() && !!metaAuth.igId;
  if (channel === 'Facebook') return metaConnected();
  return pinConnected();
}

// Each publisher returns { id, url, note }; note is set when a video fell back to a photo.
async function mktPublishPinterest(f) {
  const body = {
    board_id: await pinBoardId(f['Board'] || 'Everyday Faux Florals'),
    title: f['Pin Title'], description: f['Description'], link: mktTrackedUrl(f['Product URL'], f), alt_text: f['Alt Text'] || undefined,
    media_source: { source_type: 'image_url', url: f['Image URL'] }
  };
  let note = null;
  if (f['Media'] === 'Video' && f['Video URL']) {
    try { body.media_source = { source_type: 'video_id', media_id: await pinUploadVideo(f['Video URL']), cover_image_url: f['Image URL'] }; }
    catch (e) { note = 'Posted as a photo pin — the video failed: ' + e.message; }
  }
  const pin = await pinApi('/pins', { method: 'POST', body });
  return { id: pin.id, url: `https://www.pinterest.com/pin/${pin.id}/`, note };
}

// Instagram publishes in two steps: create a media container (a Reel from the listing video,
// or the photo), wait until Instagram has processed it, then publish it.
async function metaWaitForContainer(id) {
  for (let i = 0; i < 60; i++) { // up to ~5 minutes
    const s = await metaApi('/' + id, { params: { fields: 'status_code', access_token: metaAuth.pageToken } });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('Instagram could not process the media');
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Instagram is still processing the video — tap Retry in a few minutes');
}
async function mktPublishInstagram(f) {
  const ig = metaAuth.igId, access_token = metaAuth.pageToken;
  const container = async params => {
    const c = await metaApi(`/${ig}/media`, { method: 'POST', params: { ...params, caption: f['Description'], access_token } });
    await metaWaitForContainer(c.id);
    return c.id;
  };
  let note = null, creation_id = null;
  if (f['Media'] === 'Video' && f['Video URL']) {
    try { creation_id = await container({ media_type: 'REELS', video_url: f['Video URL'], cover_url: f['Image URL'], share_to_feed: 'true' }); }
    catch (e) { note = 'Posted as a photo — the video failed: ' + e.message; }
  }
  if (!creation_id) creation_id = await container({ image_url: f['Image URL'] });
  const media = await metaApi(`/${ig}/media_publish`, { method: 'POST', params: { creation_id, access_token } });
  const info = await metaApi('/' + media.id, { params: { fields: 'permalink', access_token } }).catch(() => ({}));
  return { id: media.id, url: info.permalink || `https://www.instagram.com/${metaAuth.igUsername || ''}/`, note };
}

// Facebook Page post: the listing video (Facebook fetches Shopify's MP4 from its URL), or the
// photo with the post text as its message.
async function mktPublishFacebook(f) {
  const page = metaAuth.pageId, access_token = metaAuth.pageToken;
  f = { ...f, 'Description': mktTrackText(f['Description'], f) };
  let note = null;
  if (f['Media'] === 'Video' && f['Video URL']) {
    try {
      const v = await metaApi(`/${page}/videos`, { method: 'POST', video: true, params: { file_url: f['Video URL'], description: f['Description'], access_token } });
      return { id: v.id, url: `https://www.facebook.com/${page}/videos/${v.id}/`, note };
    } catch (e) { note = 'Posted as a photo — the video failed: ' + e.message; }
  }
  const p = await metaApi(`/${page}/photos`, { method: 'POST', params: { url: f['Image URL'], message: f['Description'], access_token } });
  const postId = p.post_id || p.id;
  return { id: postId, url: `https://www.facebook.com/${postId}`, note };
}

// Post one approved queue row to its channel. A video that fails falls back to a photo so an
// approved post always goes out; the reason is kept in Notes and Media switches to Photo.
const mktPosting = new Set();
async function mktPostPin(id) {
  if (mktPosting.has(id)) return;
  mktPosting.add(id);
  const save = async fields => { const d = await airtableReq(`${AT_MARKETING_TBL}/${id}`, { method: 'PATCH', body: JSON.stringify({ fields, typecast: true }) }); mktCacheUpsert([d]); return d; };
  try {
    const rec = (await mktRecords()).find(r => r.id === id) || await airtableReq(`${AT_MARKETING_TBL}/${id}`);
    const f = rec.fields || {};
    if (f['Status'] !== 'Approved' || f['Pin ID']) return;
    const channel = mktChannel(f);
    // Post the logo-branded photo and the social video cut; the row keeps the Shopify originals.
    // A cut still being made holds the post until a later tick; a failed cut posts the original.
    let video = f['Video URL'], videoNote = null;
    if (cutWanted(f)) {
      const cut = cutForRow(f);
      const waited = Date.now() - (Date.parse(f['Scheduled for'] || f['Status changed'] || '') || 0);
      if (cut.status === 'working' && waited < CUT_MAX_WAIT_MS) return console.log(`marketing: ${f['EB Number']} waits for its social video cut (${cut.stage})`);
      if (cut.status === 'working') cut.error = 'it was still not ready after 3 hours';
      if (cut.status === 'ready') video = cut.url;
      else videoNote = 'Posted the listing video as it is — the 15-second cut failed: ' + cut.error;
    }
    const media = await mktBrandRow(f);
    if (videoNote) media.notes.push(videoNote);
    const g = { ...f, 'Image URL': media.image, 'Video URL': video };
    const post = await (channel === 'Instagram' ? mktPublishInstagram(g) : channel === 'Facebook' ? mktPublishFacebook(g) : mktPublishPinterest(g));
    const fields = { 'Status': 'Posted', 'Status changed': new Date().toISOString(), 'Pin ID': post.id, 'Pin URL': post.url, 'Post error': '' };
    const notes = [...media.notes, post.note].filter(Boolean);
    if (notes.length) fields['Notes'] = [f['Notes'], ...notes].filter(Boolean).join('\n');
    if (post.note) fields['Media'] = 'Photo';
    await save(fields);
    console.log(`marketing: posted ${f['EB Number']} to ${channel} as ${post.id}${post.note ? ' (photo fallback)' : ''}`);
  } catch (e) {
    console.warn(`marketing: posting ${id} failed —`, e.message);
    await save({ 'Post error': e.message.slice(0, 1000) }).catch(() => {});
  } finally { mktPosting.delete(id); }
}

// Approved rows that never went out: approved before their channel was connected, or cut off
// by a restart mid-post. Posted one at a time so two pins can't both create a missing board.
// The background pass skips rows with a Post error so a failing post waits for Retry
// instead of being retried on every app open.
// Spreading posts out: a few slots per channel per day, at times that suit the channel.
// Pinterest rewards a steady stream of fresh pins, so it gets three (about 9 am, 2 pm and 8 pm
// Central); Instagram (noon) and Facebook (2 pm) get one, since more per day splits their reach.
// Hours are UTC, so they shift an hour with daylight saving. Days are counted in Central time.
// Approving books the first free slot; if a slot earlier today was missed and nothing went
// out on that channel in the last few hours, it goes out now.
const MKT_SLOT_UTC_HOURS = { Pinterest: [1, 14, 19], Instagram: [17], Facebook: [19] };
const MKT_SLOT_GAP_MS = 3 * 60 * 60 * 1000;
const mktLocalDay = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(d);
function mktNextSlot(channel, records, now = new Date()) {
  const hours = MKT_SLOT_UTC_HOURS[channel] || [18];
  const times = records.filter(r => mktChannel(r.fields) === channel).map(r => {
    const f = r.fields || {};
    if (f['Status'] === 'Posted') return Date.parse(f['Status changed'] || '');
    if (f['Status'] === 'Approved' && f['Scheduled for']) return Date.parse(f['Scheduled for']);
    return NaN;
  }).filter(t => !isNaN(t));
  const perDay = {};
  for (const t of times) { const k = mktLocalDay(new Date(t)); perDay[k] = (perDay[k] || 0) + 1; }
  const free = slot => (perDay[mktLocalDay(slot)] || 0) < hours.length && !times.some(t => Math.abs(t - slot) < MKT_SLOT_GAP_MS);
  const today = mktLocalDay(now);
  for (let i = -1; i < 367; i++) {
    const day = [...hours].sort((a, b) => a - b).map(h => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i, h)));
    for (const slot of day) {
      if (slot > now) { if (free(slot)) return slot; }
      else if (mktLocalDay(slot) === today && free(now)) return now;
    }
  }
  return now;
}
const mktIsDue = f => !f['Scheduled for'] || Date.parse(f['Scheduled for']) <= Date.now();
// Posts whose slot has arrived go out on a 5-minute tick. It reads only the in-memory queue
// (every write goes through this server), so it costs no Airtable calls.
setInterval(() => { if (mktCache.records) mktPostPending(mktCache.records, { skipErrored: true }).catch(e => console.warn('marketing: scheduled posting failed —', e.message)); }, 5 * 60 * 1000);

let mktPendingBusy = false;
async function mktPostPending(records, { skipErrored = false } = {}) {
  if (mktPendingBusy) return;
  const ids = records.filter(r => {
    const f = r.fields || {};
    return f['Status'] === 'Approved' && !f['Pin ID'] && mktIsDue(f) && !(skipErrored && f['Post error']) && !mktPosting.has(r.id) && mktChannelReady(mktChannel(f));
  }).map(r => r.id);
  if (!ids.length) return;
  mktPendingBusy = true;
  try {
    console.log(`marketing: posting ${ids.length} approved post(s) that were waiting`);
    for (const id of ids) await mktPostPin(id);
  } finally { mktPendingBusy = false; }
}

// When a piece sells: drafts that never went out are skipped. Live pins are pointed at similar
// in-stock pieces instead of a sold-out page (manually posted pins too, when their Pin URL was
// pasted in), and Facebook posts get a note at the top with the similar-pieces link. Instagram
// captions can't be edited through the API, so those posts are left as they are.
const PIN_SOLD_LEAD = 'This piece has found its home. Explore similar arrangements, handmade by Patti. ';
async function mktHandleSold(sku) {
  const rows = (await mktRecords()).filter(r => String((r.fields || {})['EB Number'] || '').trim() === sku);
  for (const r of rows) {
    const f = r.fields, now = new Date().toISOString(), channel = mktChannel(f);
    const patch = async fields => mktCacheUpsert([await airtableReq(`${AT_MARKETING_TBL}/${r.id}`, { method: 'PATCH', body: JSON.stringify({ fields, typecast: true }) })]);
    if ((f['Status'] === 'Draft' || f['Status'] === 'Approved') && !mktPosting.has(r.id)) {
      await patch({ 'Status': 'Skipped', 'Status changed': now, 'Notes': [f['Notes'], 'Skipped automatically: the piece sold before this was posted.'].filter(Boolean).join('\n') });
      continue;
    }
    if (f['Status'] !== 'Posted' || f['Sold redirect']) continue;
    const similar = mktTrackedUrl(f['Similar URL'] || SHOP_COLLECTIONS_URL + 'shop-all', f, { sold: true });
    if (channel === 'Instagram') {
      await patch({ 'Sold redirect': now }); // nothing to change; marks it handled for the daily sweep
      continue;
    }
    if (channel === 'Facebook') {
      if (!f['Pin ID'] || !metaConnected()) continue;
      const text = `Update: this one has found its home. Similar pieces are in the shop: ${similar}\n\n${mktTrackText(f['Description'], f) || ''}`;
      await metaApi('/' + f['Pin ID'], { method: 'POST', params: { [f['Media'] === 'Video' ? 'description' : 'message']: text, access_token: metaAuth.pageToken } });
      await patch({ 'Sold redirect': now });
      console.log(`marketing: ${sku} sold — Facebook post ${f['Pin ID']} now points to similar pieces`);
      continue;
    }
    const pinId = f['Pin ID'] || ((String(f['Pin URL'] || '').match(/\/pin\/(\d+)/) || [])[1]);
    if (!pinId || !pinConnected()) continue;
    await pinApi('/pins/' + pinId, { method: 'PATCH', body: {
      link: similar,
      description: (PIN_SOLD_LEAD + (f['Description'] || '')).slice(0, 500)
    } });
    await patch({ 'Sold redirect': now });
    console.log(`marketing: ${sku} sold — pin ${pinId} now points to similar pieces`);
  }
}
function mktHandleSoldSoon(sku) { mktHandleSold(sku).catch(e => console.warn(`marketing: sold handling for ${sku} failed —`, e.message)); }
// Catch-up for sales recorded only in Airtable (craft fairs, manual edits).
async function mktSoldSweep() {
  await invEnsure();
  const skus = new Set((await mktRecords()).filter(r => {
    const f = r.fields || {};
    return (f['Status'] === 'Draft' || f['Status'] === 'Approved' || (f['Status'] === 'Posted' && !f['Sold redirect']))
      && invFindBySku(String(f['EB Number'] || '').trim()).some(i => i.fields['Status'] === 'Sold');
  }).map(r => String(r.fields['EB Number']).trim()));
  for (const sku of skus) await mktHandleSold(sku).catch(e => console.warn(`marketing: sold sweep for ${sku} failed —`, e.message));
}

app.listen(PORT, () => {
  console.log(`EB server running on port ${PORT}`);
  ensureOrderWebhook();
  ensureProductWebhook();
  pinLoadAuth().catch(e => console.warn('Pinterest: could not load the saved connection —', e.message));
  metaLoadAuth().catch(e => console.warn('Meta: could not load the saved connection —', e.message));
  if (AIRTABLE_TOKEN) mktRecords().catch(e => console.warn('marketing: could not load the queue —', e.message));
});
