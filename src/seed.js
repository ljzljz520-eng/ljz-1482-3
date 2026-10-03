// 初始内容：3 件在展展品 × 2 语言 × 3 受众 = 18 份文稿 + 1 条示范路线
const engine = require('./engine');

function mkExhibits() {
  return [
    {
      id: 'ex_bronze', code: 'BRONZE_DING', name: { zh: '青铜夔龙纹鼎', en: 'Bronze Ding with Kui-Dragon Pattern' },
      hallId: 'bronze', status: 'on_display',
      summary: { zh: '西周晚期礼器，鼎腹饰夔龙纹。', en: 'A late Western Zhou ritual vessel with kui-dragon motifs.' },
      imageLicense: { holder: '馆方摄影组', expiresAt: '2027-12-31', scope: '现场导览包' },
    },
    {
      id: 'ex_jade', code: 'JADE_PENDANT', name: { zh: '谷纹玉璧', en: 'Jade Bi Disc with Grain Pattern' },
      hallId: 'jade', status: 'on_display',
      summary: { zh: '战国玉璧，谷纹排列规整。', en: 'Warring States jade bi disc with regular grain pattern.' },
      imageLicense: { holder: '馆方摄影组', expiresAt: '2028-06-30', scope: '现场导览包' },
    },
    {
      id: 'ex_pottery', code: 'POTTERY_JAR', name: { zh: '彩绘陶仓', en: 'Painted Pottery Granary Jar' },
      hallId: 'pottery', status: 'on_display',
      summary: { zh: '西汉明器，仓身彩绘仓廪生活。', en: 'Western Han mingqi painted with granary life scenes.' },
      imageLicense: { holder: '省图档案馆', expiresAt: '2027-03-01', scope: '现场导览包' },
    },
    {
      id: 'ex_slips', code: 'BAMBOO_LAWS', name: { zh: '秦律竹简', en: 'Qin Statutes on Bamboo Slips' },
      hallId: 'slips', status: 'on_display',
      summary: { zh: '秦代法律条文抄本，可作备用展品。', en: 'Qin legal text copies, standby exhibit.' },
      imageLicense: { holder: '考古队临时授权', expiresAt: '2025-01-01', scope: '现场导览包' },
    },
  ];
}

function mkFacts() {
  const F = (id, code, content, source) => ({ id, code, version: 1, content, source, updatedAt: engine.now() });
  return [
    F('f_ding_age', 'DING_AGE', { value: { zh: '约公元前 850 年', en: 'circa 850 BCE' } }, '碳十四与铭文比对'),
    F('f_ding_find', 'DING_FIND', { value: { zh: '1976 年出土于关中窖藏', en: 'Unearthed in 1976 from a Guanzhong hoard' } }, '考古简报 1978'),
    F('f_ding_cast', 'DING_CAST', { value: { zh: '范铸法，三足分铸后合范', en: 'Piece-mould casting; legs cast separately and joined' } }, '冶金史实验室'),
    F('f_bi_age', 'BI_AGE', { value: { zh: '约公元前 300 年', en: 'circa 300 BCE' } }, '器型学分期'),
    F('f_bi_use', 'BI_USE', { value: { zh: '礼天瑞器，也用于贵族敛葬', en: 'Ritual symbol of heaven, also used in elite burials' } }, '礼制研究'),
    F('f_bi_carve', 'BI_CARVE', { value: { zh: '解玉砂蘸水磋磨成谷纹', en: 'Grain pattern abraded with quartz sand and water' } }, '微痕分析'),
    F('f_jar_age', 'JAR_AGE', { value: { zh: '约公元前 100 年', en: 'circa 100 BCE' } }, '墓葬纪年'),
    F('f_jar_bury', 'JAR_BURY', { value: { zh: '出土于西汉中型墓耳室', en: 'Found in the side chamber of a mid-rank Western Han tomb' } }, '发掘记录'),
    F('f_jar_paint', 'JAR_PAINT', { value: { zh: '矿物颜料彩绘，铅白打底', en: 'Mineral pigments over a lead-white ground' } }, '颜料光谱检测'),
  ];
}

// 文稿文本表：TEXTS[exhibit][lang][audience] = [[segCode, zh/en 文本, factRefs], ...]
const TEXTS = {
  ex_bronze: {
    zh: {
      child: [
        ['intro', '小朋友快看！这只三条腿的大锅叫鼎，以前是用来煮肉、也是摆排场的宝贝。', []],
        ['age', '它快三千岁啦，比爷爷奶奶的爷爷奶奶还要老好多好多！', ['f_ding_age']],
        ['find', '它是 1976 年在一个地洞里被发现的，当时挤着好多青铜器。', ['f_ding_find']],
        ['cast', '做它可费劲啦：先拿泥巴刻出花纹模子，再浇铜水，三条腿是另外做好再拼上的。', ['f_ding_cast']],
      ],
      general: [
        ['intro', '这件青铜鼎是西周晚期的礼器，鼎腹四面装饰卷尾的夔龙纹。', []],
        ['age', '据碳十四测年并结合铭文比对，年代约在公元前 850 年。', ['f_ding_age']],
        ['find', '1976 年，它出土于关中一处青铜器窖藏。', ['f_ding_find']],
        ['cast', '器身采用范铸法成形，三足分铸后再合范浇接。', ['f_ding_cast']],
      ],
      expert: [
        ['intro', '此器为西周晚期列鼎制度下的实用礼器，腹饰两两相对的垂冠夔龙纹。', []],
        ['age', '碳十四数据与器形谱系交叉定年，落在西周厉王前后约公元前 850 年。', ['f_ding_age']],
        ['find', '1976 年关中窖藏出土，同出器群具有贵族家族器的聚藏特征。', ['f_ding_find']],
        ['cast', '铸艺为分块范铸，器壁可见范线；三足先铸并预置榫头，二次浇铸合范。', ['f_ding_cast']],
      ],
    },
    en: {
      child: [
        ['intro', 'Look! This three-legged pot is called a ding. It cooked meat and showed how important a family was.', []],
        ['age', 'It is almost three thousand years old — older than all your grandparents, many times over!', ['f_ding_age']],
        ['find', 'It was found in 1976 in an underground cellar full of bronze vessels.', ['f_ding_find']],
        ['cast', 'Making it was hard: clay moulds carried the pattern, bronze was poured in, and the legs were made first, then joined.', ['f_ding_cast']],
      ],
      general: [
        ['intro', 'This bronze ding is a late Western Zhou ritual vessel, decorated with curling kui-dragon motifs.', []],
        ['age', 'Radiocarbon dating and inscription comparison place it around 850 BCE.', ['f_ding_age']],
        ['find', 'It was unearthed in 1976 from a bronze hoard in the Guanzhong region.', ['f_ding_find']],
        ['cast', 'The body was made by piece-mould casting; the three legs were cast separately and joined.', ['f_ding_cast']],
      ],
      expert: [
        ['intro', 'A ritual ding within the late Western Zhou lie-ding system, bearing paired drooping-crested kui dragons.', []],
        ['age', 'Radiocarbon and typological cross-dating place it near the reign of King Li, circa 850 BCE.', ['f_ding_age']],
        ['find', 'Excavated in 1976 from a Guanzhong hoard whose assemblage suggests a noble lineage cache.', ['f_ding_find']],
        ['cast', 'Sectional piece-mould casting with visible mould seams; legs pre-cast with tenons and joined in a second pour.', ['f_ding_cast']],
      ],
    },
  },
  ex_jade: {
    zh: {
      child: [
        ['intro', '这块圆圆的、扁扁的玉叫玉璧，中间有个小甜甜圈一样的洞。', []],
        ['age', '它两千三百多岁了，是战国时候的小朋友的大人留下的。', ['f_bi_age']],
        ['use', '古人觉得圆璧像天空，会在重要仪式上捧着它，也会放进墓里陪人。', ['f_bi_use']],
        ['carve', '玉很硬，工匠要蘸着水和细砂子，一点点磨出这些小逗号花纹。', ['f_bi_carve']],
      ],
      general: [
        ['intro', '这是一件战国谷纹玉璧，璧面布满饱满的谷纹。', []],
        ['age', '按器形学分期，年代约为公元前 300 年的战国中晚期。', ['f_bi_age']],
        ['use', '玉璧是礼天的瑞器，也常见于高等级墓葬的敛葬组合。', ['f_bi_use']],
        ['carve', '谷纹以解玉砂蘸水磋磨成形，排列匀整。', ['f_bi_carve']],
      ],
      expert: [
        ['intro', '战国中晚期谷纹璧，谷芽隆起且旋向一致，属楚式工艺谱系。', []],
        ['age', '器形学定年约公元前 300 年，与同期楚墓璧形器相合。', ['f_bi_age']],
        ['use', '其礼天与敛葬双重功能，可与《周礼》六瑞体系互证。', ['f_bi_use']],
        ['carve', '微痕显示以石英解玉砂蘸水往复磋磨，先定点后扩形，谷纹轮廓呈规律崩口。', ['f_bi_carve']],
      ],
    },
    en: {
      child: [
        ['intro', 'This round, flat jade is called a bi, with a little donut hole in the middle.', []],
        ['age', 'It is over two thousand three hundred years old, from the Warring States period.', ['f_bi_age']],
        ['use', 'People thought the round disc looked like the sky. They held it in ceremonies and placed it in tombs.', ['f_bi_use']],
        ['carve', 'Jade is very hard! Craftsmen rubbed it with sand and water, slowly grinding out these little comma marks.', ['f_bi_carve']],
      ],
      general: [
        ['intro', 'This is a Warring States jade bi disc covered with plump grain patterns.', []],
        ['age', 'Typological dating places it around 300 BCE, the mid-late Warring States period.', ['f_bi_age']],
        ['use', 'The bi symbolized heaven in ritual and often appeared in elite burial sets.', ['f_bi_use']],
        ['carve', 'The grain pattern was abraded with quartz sand and water in even rows.', ['f_bi_carve']],
      ],
      expert: [
        ['intro', 'A mid-late Warring States grain-pattern bi with uniformly spiraling buds, in the Chu craft lineage.', []],
        ['age', 'Typology dates it to circa 300 BCE, matching discs from contemporaneous Chu tombs.', ['f_bi_age']],
        ['use', 'Its dual roles in heaven ritual and burial assemblages corroborate the six-rui system of the Zhouli.', ['f_bi_use']],
        ['carve', 'Microwear shows reciprocating abrasion with quartz sand and water: dots first, shapes expanded, with systematic edge chipping.', ['f_bi_carve']],
      ],
    },
  },
  ex_pottery: {
    zh: {
      child: [
        ['intro', '这个像小粮仓的陶器，是专门做给去世的人用的，希望他们到了另一边也有饭吃。', []],
        ['age', '它是大约两千一百年前西汉时候做的。', ['f_jar_age']],
        ['bury', '它在一座西汉墓的小耳室里被发现，当时还摆着其他生活小模型。', ['f_jar_bury']],
        ['paint', '上面的画是用彩色石头磨成粉画的，先刷一层白白的铅白打底。', ['f_jar_paint']],
      ],
      general: [
        ['intro', '这是一件西汉彩绘陶仓，属模拟粮仓的明器。', []],
        ['age', '据墓葬纪年材料，年代约为公元前 100 年。', ['f_jar_age']],
        ['bury', '它出土于一座西汉中型墓的耳室，与井、灶模型共出。', ['f_jar_bury']],
        ['paint', '彩绘使用矿物颜料，以铅白打底后施色。', ['f_jar_paint']],
      ],
      expert: [
        ['intro', '西汉中期彩绘陶仓明器，仓顶作庑殿式，器表绘仓廪出纳场景。', []],
        ['age', '据同墓纪年陶器排比，年代约公元前 100 年，西汉中期偏晚。', ['f_jar_age']],
        ['bury', '出土于中型墓耳室，与井、灶、磨模型构成成套生业明器组合。', ['f_jar_bury']],
        ['paint', '光谱分析显示铅白底上施赤铁矿红与炭黑，矿物颜料层清晰。', ['f_jar_paint']],
      ],
    },
    en: {
      child: [
        ['intro', 'This pottery little granary was made for someone who had passed away, so they would have food in the next world.', []],
        ['age', 'It was made around two thousand one hundred years ago, in the Western Han dynasty.', ['f_jar_age']],
        ['bury', 'It was found in a little side room of a Han tomb, next to small models of daily life.', ['f_jar_bury']],
        ['paint', 'The pictures were painted with powdered colored stones on a white lead-white base.', ['f_jar_paint']],
      ],
      general: [
        ['intro', 'This is a Western Han painted pottery granary jar, a mingqi modeled after a real granary.', []],
        ['age', 'Tomb-dating evidence places it around 100 BCE.', ['f_jar_age']],
        ['bury', 'It came from the side chamber of a mid-rank Western Han tomb, together with well and stove models.', ['f_jar_bury']],
        ['paint', 'Mineral pigments were applied over a lead-white ground.', ['f_jar_paint']],
      ],
      expert: [
        ['intro', 'A mid-Western Han mingqi granary with a hip-form roof and painted grain-issuing scenes.', []],
        ['age', 'Seriation with dated vessels places it circa 100 BCE, late mid-Western Han.', ['f_jar_age']],
        ['bury', 'From a side chamber, part of a livelihood-mingqi set: well, stove, and mill models.', ['f_jar_bury']],
        ['paint', 'Spectroscopy shows hematite red and carbon black over a distinct lead-white ground layer.', ['f_jar_paint']],
      ],
    },
  },
};

function build(store) {
  store.exhibits = mkExhibits();
  store.facts = mkFacts();
  store.scripts = [];
  store.audioTasks = [];
  for (const [exhibitId, byLang] of Object.entries(TEXTS)) {
    for (const lang of ['zh', 'en']) {
      for (const audience of ['child', 'general', 'expert']) {
        const rows = byLang[lang][audience];
        const sc = {
          id: store.nextId('scr'), exhibitId, lang, audience, version: 1,
          segments: rows.map(([code, text, refs], i) => ({
            code, index: i, text, factRefs: refs,
            audio: { status: 'pending' }, subtitle: { status: 'pending' },
            updatedAt: engine.now(),
          })),
          approval: null, factFlag: null, updatedAt: engine.now(),
        };
        sc.wordingHash = engine.computeWordingHash(sc);
        store.scripts.push(sc);
        engine.reconcileScript(store, sc);
      }
    }
  }
  // 初始音频/字幕任务全部完成（稳定片段身份：任务按片段提交）
  for (const t of [...store.audioTasks]) engine.completeTask(store, t.id);

  // 18 份文稿均审批通过
  for (const sc of store.scripts) engine.approveScript(store, sc.id, 'curator');

  const route = {
    id: 'rt_main', name: { zh: '镇馆之宝·三厅线', en: 'Highlights: Three-Gallery Walk' },
    version: 1, createdAt: engine.now(), updatedAt: engine.now(),
    stops: [
      { stopId: 'stp_1', exhibitId: 'ex_bronze' },
      { stopId: 'stp_2', exhibitId: 'ex_jade' },
      { stopId: 'stp_3', exhibitId: 'ex_pottery' },
    ],
    transits: [], validation: null, durations: {},
  };
  store.routes.push(route);
  engine.syncRouteTransits(store, route);
  for (const t of [...store.audioTasks].filter((x) => x.status === 'queued')) engine.completeTask(store, t.id);
  engine.validateRoute(store, route);
  engine.recomputeRouteDuration(store, route);
  return store;
}

module.exports = { build };
