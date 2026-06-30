const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const FormData = require('form-data'); // streaming multipart for staged video uploads
 
const app = express();
app.use(express.json({limit: '150mb'}));
app.use(cors({
  origin: [
    'https://roberthale65-cyber.github.io',
    'https://eternalbloomsbypatti.com',
    'https://eternalbloomsdesigns.com',
    'null'
  ]
}));
 
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
  'Fern':'gid://shopify/Metaobject/214355804295','Daisy':'gid://shopify/Metaobject/214355902599','Ivy':'gid://shopify/Metaobject/214355968135','Other':'gid://shopify/Metaobject/214356033671','Geranium':'gid://shopify/Metaobject/214392635527','Hydrangea':'gid://shopify/Metaobject/245697446023','Magnolia':'gid://shopify/Metaobject/246351790215','Tulip':'gid://shopify/Metaobject/246352117895','Sunflower':'gid://shopify/Metaobject/246375514247','Spider Mums':'gid://shopify/Metaobject/246375809159','Wisteria':'gid://shopify/Metaobject/246380658823','Decorative Berries Artificial':'gid://shopify/Metaobject/246394093703','Freesia':'gid://shopify/Metaobject/246395240583','Ranunculus':'gid://shopify/Metaobject/246395469959','Rose':'gid://shopify/Metaobject/246395535495','Poppies':'gid://shopify/Metaobject/246539681927','Wax Flowers':'gid://shopify/Metaobject/247317725319','Dahlia':'gid://shopify/Metaobject/247325393031','Pine':'gid://shopify/Metaobject/247325425799','Pansy':'gid://shopify/Metaobject/247338532999','Plum Blossom':'gid://shopify/Metaobject/247340073095','Cherry Blossoms':'gid://shopify/Metaobject/247350919303','Flower Buds':'gid://shopify/Metaobject/247351181447','Ranunculus Roses':'gid://shopify/Metaobject/247775035527','Grape vine':'gid://shopify/Metaobject/247775068295','Wildflower':'gid://shopify/Metaobject/248712396935','Peony':'gid://shopify/Metaobject/248761319559','Aeonium':'gid://shopify/Metaobject/248788811911','Allium':'gid://shopify/Metaobject/248788844679','Alocasia':'gid://shopify/Metaobject/248788877447','Aloe vera':'gid://shopify/Metaobject/248788910215','Amaryllis':'gid://shopify/Metaobject/248788942983','Anthurium':'gid://shopify/Metaobject/248788975751','Aralia':'gid://shopify/Metaobject/248789008519','Aubergine':'gid://shopify/Metaobject/248789041287','Bamboo':'gid://shopify/Metaobject/248789074055','Basil':'gid://shopify/Metaobject/248789106823','Bay leaves':'gid://shopify/Metaobject/248789139591','Begonia':'gid://shopify/Metaobject/248789172359','Bell pepper':'gid://shopify/Metaobject/248789205127','Bird of paradise':'gid://shopify/Metaobject/248789237895','Bonsai':'gid://shopify/Metaobject/248789270663','Bougainvillea':'gid://shopify/Metaobject/248789303431','Boxwood':'gid://shopify/Metaobject/248789336199','Cactus':'gid://shopify/Metaobject/248789368967','Calathea':'gid://shopify/Metaobject/248789401735','Cherry':'gid://shopify/Metaobject/248789434503','Cherry tomato':'gid://shopify/Metaobject/248789467271','Chervil':'gid://shopify/Metaobject/248789500039','Chives':'gid://shopify/Metaobject/248789532807','Chrysanthemum':'gid://shopify/Metaobject/248789565575','Cilantro':'gid://shopify/Metaobject/248789598343','Coriander':'gid://shopify/Metaobject/248789631111','Cotton':'gid://shopify/Metaobject/248789663879','Courgette':'gid://shopify/Metaobject/248789696647','Crocus':'gid://shopify/Metaobject/248789729415','Cucumber':'gid://shopify/Metaobject/248789762183','Curry leaves':'gid://shopify/Metaobject/248789794951','Cyclamen':'gid://shopify/Metaobject/248789827719','Daffodil':'gid://shopify/Metaobject/248789860487','Dandelion':'gid://shopify/Metaobject/248789893255','Dill':'gid://shopify/Metaobject/248789926023','Echeveria':'gid://shopify/Metaobject/248789958791','Echinacea':'gid://shopify/Metaobject/248789991559','Edelweiss':'gid://shopify/Metaobject/248790024327','Eucalyptus':'gid://shopify/Metaobject/248790057095','Fennel':'gid://shopify/Metaobject/248790089863','Ficus':'gid://shopify/Metaobject/248790122631','Fir':'gid://shopify/Metaobject/248790155399','Forsythia':'gid://shopify/Metaobject/248790188167','Galanthus':'gid://shopify/Metaobject/248790220935','Gardenia':'gid://shopify/Metaobject/248790319239','Grass':'gid://shopify/Metaobject/248790352007','Hibiscus':'gid://shopify/Metaobject/248790384775','Honeysuckle':'gid://shopify/Metaobject/248790417543','Hosta':'gid://shopify/Metaobject/248790450311','Hyacinth':'gid://shopify/Metaobject/248790483079','Jasmine':'gid://shopify/Metaobject/248790515847','Lavender':'gid://shopify/Metaobject/248790548615','Lily':'gid://shopify/Metaobject/248790581383','Marigold':'gid://shopify/Metaobject/248790614151','Marjoram':'gid://shopify/Metaobject/248790646919','Mint':'gid://shopify/Metaobject/248790679687','Miscanthus sinensis':'gid://shopify/Metaobject/248790712455','Monstera':'gid://shopify/Metaobject/248790745223','Olive':'gid://shopify/Metaobject/248790777991','Orchid':'gid://shopify/Metaobject/248790810759','Oregano':'gid://shopify/Metaobject/248790843527','Palm':'gid://shopify/Metaobject/248790876295','Pampas grass':'gid://shopify/Metaobject/248790909063','Papyrus':'gid://shopify/Metaobject/248790941831','Parsley':'gid://shopify/Metaobject/248790974599','Petunia':'gid://shopify/Metaobject/248791007367','Phalaenopsis':'gid://shopify/Metaobject/248791105671','Philodendron':'gid://shopify/Metaobject/248791138439','Poinsettia':'gid://shopify/Metaobject/248791171207','Protea':'gid://shopify/Metaobject/248791203975','Rosemary':'gid://shopify/Metaobject/248791236743','Rubber plant':'gid://shopify/Metaobject/248791269511','Sage':'gid://shopify/Metaobject/248791302279','Sansevieria':'gid://shopify/Metaobject/248791335047','Spider plant':'gid://shopify/Metaobject/248791367815','Sweet pea':'gid://shopify/Metaobject/248791400583','Tarragon':'gid://shopify/Metaobject/248791433351','Thyme':'gid://shopify/Metaobject/248791466119','Tomato':'gid://shopify/Metaobject/248791498887','Venus flytrap':'gid://shopify/Metaobject/248791531655','Violet':'gid://shopify/Metaobject/248791564423','Water lily':'gid://shopify/Metaobject/248791597191','Weeping fig':'gid://shopify/Metaobject/248791629959','Willow':'gid://shopify/Metaobject/248791662727','Yarrow':'gid://shopify/Metaobject/248791695495','Yucca':'gid://shopify/Metaobject/248791728263','Zamioculcas':'gid://shopify/Metaobject/248791761031','Zinnia':'gid://shopify/Metaobject/248791793799'
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
const SHOPIFY_ARRANGEMENT_METAOBJECTS = {
  'Other':'gid://shopify/Metaobject/214355771527','Wall-Door Pocket':'gid://shopify/Metaobject/246336356487','Centerpiece':'gid://shopify/Metaobject/246351331463','Metal Planter':'gid://shopify/Metaobject/246373056647','Home Decor':'gid://shopify/Metaobject/246375415943','Wall Pocket':'gid://shopify/Metaobject/246375940231','Door Decor':'gid://shopify/Metaobject/246380593287','Vase':'gid://shopify/Metaobject/246395306119','Pot':'gid://shopify/Metaobject/247336304775','Planter':'gid://shopify/Metaobject/247339843719','Basket':'gid://shopify/Metaobject/248792055943','Bouquet':'gid://shopify/Metaobject/248792088711','Box':'gid://shopify/Metaobject/248792121479'
};
const SHOPIFY_CONTAINER_METAOBJECTS = {
  'Planter':'gid://shopify/Metaobject/245698363527','Pot':'gid://shopify/Metaobject/246395437191','Vase':'gid://shopify/Metaobject/246395502727','Barrel':'gid://shopify/Metaobject/248792154247','Basket':'gid://shopify/Metaobject/248792187015','Box':'gid://shopify/Metaobject/248792219783','None':'gid://shopify/Metaobject/248792252551','Other':'gid://shopify/Metaobject/248792285319','Urn':'gid://shopify/Metaobject/248792318087'
};
const SHOPIFY_STEM_METAOBJECTS = {
  'Medium':'gid://shopify/Metaobject/246395404423','Long':'gid://shopify/Metaobject/246539714695','Short':'gid://shopify/Metaobject/248750866567','Other':'gid://shopify/Metaobject/248792350855'
};
// Full decoration-material coverage. Last 4 are crosswalks (no taxonomy twin):
// Grapevine/Pine → Wood, Candle/Lights → Other.
const SHOPIFY_DECORATION_MATERIAL_METAOBJECTS = {
  'Fabric':'gid://shopify/Metaobject/245698429063','Resin':'gid://shopify/Metaobject/246375317639','Metal':'gid://shopify/Metaobject/246375547015','Silk':'gid://shopify/Metaobject/246375579783','Ceramic':'gid://shopify/Metaobject/246395371655','Wool':'gid://shopify/Metaobject/247312646279','Plastic':'gid://shopify/Metaobject/247339417735','Wood':'gid://shopify/Metaobject/248712364167','Acrylic':'gid://shopify/Metaobject/248786452615','Aluminum':'gid://shopify/Metaobject/248786485383','Bamboo':'gid://shopify/Metaobject/248786518151','Brass':'gid://shopify/Metaobject/248786550919','Bronze':'gid://shopify/Metaobject/248786583687','Canvas':'gid://shopify/Metaobject/248786616455','Capiz':'gid://shopify/Metaobject/248786649223','Cardboard':'gid://shopify/Metaobject/248786681991','Cast iron':'gid://shopify/Metaobject/248786714759','Chrome':'gid://shopify/Metaobject/248786747527','Concrete':'gid://shopify/Metaobject/248786780295','Copper':'gid://shopify/Metaobject/248786813063','Cork':'gid://shopify/Metaobject/248786845831','Cotton':'gid://shopify/Metaobject/248786878599','Crystal':'gid://shopify/Metaobject/248786911367','Faux fur':'gid://shopify/Metaobject/248786944135','Faux leather':'gid://shopify/Metaobject/248786976903','Feathers':'gid://shopify/Metaobject/248787009671','Felt':'gid://shopify/Metaobject/248787042439','Glass':'gid://shopify/Metaobject/248787075207','Hemp':'gid://shopify/Metaobject/248787107975','Iron':'gid://shopify/Metaobject/248787140743','Jute':'gid://shopify/Metaobject/248787173511','Latex':'gid://shopify/Metaobject/248787206279','Leather':'gid://shopify/Metaobject/248787239047','Marble':'gid://shopify/Metaobject/248787271815','Medium density fiberboard (MDF)':'gid://shopify/Metaobject/248787304583','Melamine':'gid://shopify/Metaobject/248787435655','Nylon':'gid://shopify/Metaobject/248787468423','Other':'gid://shopify/Metaobject/248787501191','Paper':'gid://shopify/Metaobject/248787533959','Papier-mâché':'gid://shopify/Metaobject/248787566727','Plush':'gid://shopify/Metaobject/248787599495','Polyester':'gid://shopify/Metaobject/248787632263','Polypropylene (PP)':'gid://shopify/Metaobject/248787665031','Polyvinyl chloride (PVC)':'gid://shopify/Metaobject/248787697799','Porcelain':'gid://shopify/Metaobject/248787730567','Rattan':'gid://shopify/Metaobject/248787763335','Rubber':'gid://shopify/Metaobject/248787796103','Satin':'gid://shopify/Metaobject/248787828871','Sequins':'gid://shopify/Metaobject/248787861639','Silicone':'gid://shopify/Metaobject/248787894407','Stainless steel':'gid://shopify/Metaobject/248787927175','Steel':'gid://shopify/Metaobject/248787959943','Stone':'gid://shopify/Metaobject/248787992711','Suede':'gid://shopify/Metaobject/248788025479','Synthetic':'gid://shopify/Metaobject/248788058247','Terracotta':'gid://shopify/Metaobject/248788091015','Velour':'gid://shopify/Metaobject/248788123783','Velvet':'gid://shopify/Metaobject/248788156551','Veneer':'gid://shopify/Metaobject/248788189319','Vinyl':'gid://shopify/Metaobject/248788222087','Wax':'gid://shopify/Metaobject/248788254855','Zinc':'gid://shopify/Metaobject/248788287623','Grapevine':'gid://shopify/Metaobject/248712364167','Pine':'gid://shopify/Metaobject/248712364167','Candle':'gid://shopify/Metaobject/248787501191','Lights':'gid://shopify/Metaobject/248787501191'
};
// Full planter-material coverage. Crosswalks: Galvanized Steel → Metal, Basket → Other.
const SHOPIFY_PLANTER_MATERIAL_METAOBJECTS = {
  'Metal':'gid://shopify/Metaobject/245698330759','Ceramic':'gid://shopify/Metaobject/246395338887','Wood':'gid://shopify/Metaobject/247312613511','Resin':'gid://shopify/Metaobject/247317856391','Bamboo':'gid://shopify/Metaobject/248788353159','Concrete':'gid://shopify/Metaobject/248788385927','Glass':'gid://shopify/Metaobject/248788418695','Other':'gid://shopify/Metaobject/248788451463','Plastic':'gid://shopify/Metaobject/248788484231','Stone':'gid://shopify/Metaobject/248788516999','Terracotta':'gid://shopify/Metaobject/248788549767','Galvanized Steel':'gid://shopify/Metaobject/245698330759','Basket':'gid://shopify/Metaobject/248788451463'
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

// Which shopify-namespace taxonomy metafields are valid for each product category.
// Shopify REJECTS a productUpdate that sets a metafield outside the category's
// attribute set, so we filter by category before sending. color-pattern is treated
// as universal (works on uncategorised Add-ons too, preserving prior behaviour).
const CATEGORY_METAFIELD_KEYS = {
  'Artificial Flowering Plants': ['plant-name','suitable-location','arrangement','plant-container-type','stem-length','decoration-material','planter-material'],
  // The Shopify Wreaths taxonomy category (hg-3-76-2) has NO decoration-material or
  // planter-material attributes — only Celebration type, Lighting options, Shape (plus
  // the universal Color/Pattern, and auto-set Material/Plant material). Including the
  // two invalid keys here made every wreath productUpdate fail with userErrors, which
  // (being atomic) also rolled back the category assignment → category stayed null and
  // ALL metafields dropped. (Decoration/planter material for wreaths is still in
  // Airtable; folding it into shopify.material is a separate enhancement.)
  'Wreaths': ['celebration-type','lighting-options','shape']
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
async function airtableReq(tablePath, opts = {}) {
  if (!AIRTABLE_TOKEN) throw new Error('AIRTABLE_TOKEN not configured on server');
  const url = tablePath.startsWith('https://')
    ? tablePath
    : `https://api.airtable.com/v0/${AT_BASE_ID}/${tablePath}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + AIRTABLE_TOKEN,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Airtable error ' + res.status + ': ' + JSON.stringify(err));
  }
  return res.json();
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
  // Changing this string requires re-running /auth so Shopify re-grants the scopes.
  const scopes = 'read_products,write_products,read_inventory,write_inventory';
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
app.get('/airtable/inventory', async (req, res) => {
  const { offset } = req.query;
  try {
    let path = `${AT_INVENTORY_TBL}?pageSize=100`;
    if (offset) path += '&offset=' + encodeURIComponent(offset);
    const data = await airtableReq(path);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /airtable/inventory/:id — fetch single inventory record
app.get('/airtable/inventory/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const data = await airtableReq(`${AT_INVENTORY_TBL}/${id}`);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /airtable/inventory — create new inventory record
app.post('/airtable/inventory', async (req, res) => {
  const { fields } = req.body;
  if (!fields) return res.status(400).json({ error: 'fields required' });
  try {
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
    const data = await airtableReq('Bins', {
      method: 'POST',
      body: JSON.stringify({ fields })
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
  const { eb_number, reference_name, type, season, holiday, colors, dimensions, materials, location, special, notes, images } = req.body;
  const textPrompt = `You write product listings for Eternal Blooms Designs, a handmade artificial flower arrangement business in Omaha, Nebraska. Each piece is handmade and one of a kind.

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
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: `Fix any spelling and grammar errors in the text below. Keep the same meaning, tone, and style. Return ONLY the corrected text with no explanation, no quotes, no preamble.\n\n${text}` }] })
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
 
// ── Version / health (verify what's actually deployed) ────────
app.get('/version', (req, res) => res.json({ version: '2026-06-30-fixpack2', features: ['inventory-set: @idempotent+changeFromQuantity (2026-04 fix)', 'wreath category fix: drop invalid decoration/planter keys', 'lighting GID swap fixed (Illuminated/Non-illuminated)', 'resync-attributes(add-only+inventory)', 'plant-material=Artificial', 'material=Synthetic(wreaths)', 'wreath-metafields:shape/lighting/celebration', 'category-gated-metafields'] }));

// Resolve the tool-owned taxonomy metafield GIDs for a product, category-gated.
// Shared by /create-product (replace) and /resync-attributes (merge) so the value→GID
// wiring lives in one place. Returns per-key GID lists + the set of keys valid for the
// category (color-pattern is universal). Unmapped values are dropped.
function buildToolMetafieldGids(product_category, body){
  const { colors, pattern, plant_name, locations, arrangement, plant_container_type, stem_length, decoration_material, planter_material, celebration_type, lighting_options, shape } = body;
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
    'shape':                mapGids(shape, SHOPIFY_SHAPE_METAOBJECTS)
  };
  const allowed = new Set(['color-pattern'].concat(CATEGORY_METAFIELD_KEYS[product_category] || []));
  return { categoryGid: SHOPIFY_CATEGORY_GIDS[product_category], colorGids, patternGids, perKey, allowed };
}

// ── Create product ────────────────────────────────────────────
app.post('/create-product', async (req, res) => {
  if (!shopifyAccessToken) return res.status(401).json({ error: 'Not authorized. Visit ' + SERVER_URL + '/auth to complete Shopify OAuth first.' });
  const { title, body_html, sku, price, tags, product_type, collections, weight_oz, weight_lbs, dimensions, meta_description, requires_shipping, images, quantity, product_category, colors, pattern, plant_name, locations, arrangement, plant_container_type, stem_length, decoration_material, planter_material, celebration_type, lighting_options, shape } = req.body;
  if (!title || !sku) return res.status(400).json({ error: 'title and sku are required' });
  // Inventory quantity — default to 1 (one-of-a-kind) when unset; clamp to a non-negative integer.
  const qty = (quantity != null && quantity !== '' && Number.isFinite(Number(quantity))) ? Math.max(0, Math.round(Number(quantity))) : 1;
  const variant = { sku, price: price || '0.00', inventory_management: 'shopify', inventory_policy: 'deny', fulfillment_service: 'manual', requires_shipping: requires_shipping !== false };
  // Weight: prefer ounces (Shopify WeightUnit OUNCES) — exact, matches the Airtable "Item weight (oz)" field.
  if (weight_oz != null && weight_oz !== '') { variant.weight = Number(weight_oz); variant.weight_unit = 'oz'; }
  else if (weight_lbs) { variant.weight = Math.round(weight_lbs * 453.592); variant.weight_unit = 'g'; }
  let fullDescription = body_html || '';
  if (dimensions) {
    fullDescription += '<p><strong>Dimensions:</strong> ' + dimensions + '</p>';
    fullDescription += '<p><em>Product dimensions are measured from tip to tip of leaves or flowers.</em></p>';
  }
  const productPayload = {
    product: {
      title, body_html: fullDescription, vendor: 'Eternal Blooms Designs', product_type: product_type || '', tags: tags || '',
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
    // Wreaths are synthetic — auto-set shopify.material = Synthetic. Own update (Material
    // is a Wreaths attribute; not valid for AFP, so gate on category and isolate it).
    if (product_category === 'Wreaths') {
      try {
        const matMutation = `mutation productUpdate($product:ProductUpdateInput!){productUpdate(product:$product){userErrors{field message}}}`;
        const matData = await shopifyGraphql(matMutation, { product: { id: `gid://shopify/Product/${productId}`, metafields: [{ namespace: 'shopify', key: 'material', type: 'list.metaobject_reference', value: JSON.stringify([SHOPIFY_MATERIAL_SYNTHETIC]) }] } });
        const matErrs = matData?.data?.productUpdate?.userErrors || [];
        if (matErrs.length) console.warn('material (Synthetic) not set:', matErrs.map(e => e.message).join(', '));
        else console.log('material set: Synthetic →', sku);
      } catch (matErr) { console.warn('material update failed (non-fatal):', matErr.message); }
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
    res.json({ success: true, product_id: productId, handle: data.product.handle, shopify_url: productUrl, admin_url: `https://admin.shopify.com/store/zdzva0-tj/products/${productId}`, hero_image_url: heroImageUrl, collections_assigned: collectionResults, quantity: qty, category: (categoryGid ? product_category : null), colors_set: colorGids.length, pattern_set: patternGids.length, metafields_set: metafieldsSet });
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
  const { sku, quantity, product_category } = req.body;
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
    // Auto-rules (also add-only): plant-material=Artificial on any category, material=Synthetic on Wreaths
    if (categoryGid) unionInto('plant-material', [SHOPIFY_PLANT_MATERIAL_ARTIFICIAL]);
    if (product_category === 'Wreaths') unionInto('material', [SHOPIFY_MATERIAL_SYNTHETIC]);

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

app.listen(PORT, () => console.log(`EB server running on port ${PORT}`));
