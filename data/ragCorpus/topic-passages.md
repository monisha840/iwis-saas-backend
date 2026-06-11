# Topic Passages — Curated Ayurvedic Knowledge Base

These are the MD-reviewed long-form passages the RAG retriever grounds the voice coach against.

## Format

Each passage is a block beginning with `---id: <slug>` on its own line, followed by `topic:`, `sources:`, and `tags:` metadata lines, then a blank line, then the body. The body is plain prose, 200-400 words. Citations to classical texts (Charaka Samhita, Sushruta Samhita, Ashtanga Hridaya, Bhavaprakasha) should be specific where possible (chapter/verse).

Add new passages by appending new `---id:` blocks at the end of this file. Then re-run `node scripts/buildRagIndex.js` to regenerate the corpus.

## Seed passages (LLM-drafted — REQUIRES MD REVIEW before clinical use)

The 10 passages below were drafted by an LLM as a bootstrap corpus. **None has been clinically reviewed yet.** They are tagged `unreviewed: true` so the retriever can be filtered to exclude them in production until the MD signs off. Once reviewed and corrected, change `unreviewed: true` to `unreviewed: false`.

---id: seed-vata-pacification-winter
topic: Vata pacification during Hemanta and Shishira (early and late winter)
sources: Charaka Samhita Sutrasthana 6 (Tasyashiteeya Adhyaya), Ashtanga Hridaya Sutrasthana 3
tags: vata, hemanta, shishira, ritucharya, pacification, winter, diet
unreviewed: true

In the cold seasons of Hemanta (early winter, roughly November to December) and Shishira (late winter, January to February), the qualities of cold (shita), dryness (ruksha), and lightness (laghu) dominate the environment. These same qualities are intrinsic to Vata dosha, so Vata accumulates and aggravates in classically Vata-prone individuals during this time.

The pacification protocol prescribed in Charaka Samhita Sutrasthana 6 emphasises the opposite qualities — warmth (ushna), unctuousness (snigdha), and heaviness (guru). Specific recommendations include: daily abhyanga (full-body self-oil massage) with warm sesame or mahanarayana oil before bathing; warm baths rather than cool showers; foods cooked with ghee, sesame oil, or coconut oil; sweet, sour, and salty tastes prioritised over bitter, astringent, and pungent; warm spices such as ginger, cinnamon, cardamom, cloves, and asafoetida added to meals; warm milk with saffron or ashwagandha before sleep.

Lifestyle prescriptions in Hemanta also include rising slightly later (not before sunrise on the coldest days), wearing warm natural fibres (wool, silk, cotton), and avoiding cold winds especially around the ears, neck, and lower back where Vata tends to enter and accumulate. Travel, late nights, and over-stimulation should be reduced — Vata is the dosha most disturbed by erratic schedules.

Patients with Vata-Pitta or Vata-Kapha mixed constitutions should still observe these guidelines in winter, but moderate the heaviness of foods if Kapha signs (heaviness, sluggishness, congestion) appear. Patients with pure Pitta constitution typically do well in winter and need only mild Vata-pacification, mainly via oil massage and avoiding excessive cold-dry exposure.

---id: seed-pitta-pacification-summer
topic: Pitta pacification during Grishma (summer)
sources: Charaka Samhita Sutrasthana 6, Ashtanga Hridaya Sutrasthana 3
tags: pitta, grishma, ritucharya, pacification, summer, diet, cooling
unreviewed: true

Grishma (summer, roughly May to June) carries the qualities of heat (ushna), sharpness (tikshna), and lightness (laghu). These mirror the qualities of Pitta dosha, so Pitta accumulates and aggravates during summer, especially in classically Pitta-prone individuals.

Pitta pacification in Grishma centres on cooling, mild, and sweet qualities. Diet should emphasise: sweet, bitter, and astringent tastes; foods like rice, milk, ghee, sweet ripe fruits (grapes, pomegranates, sweet mangoes, pears), coconut water, mint, coriander, fennel, rose water; cooling spices such as fennel, coriander, and cardamom in place of warming chillies and pepper. Avoid or reduce: chillies, vinegar, alcohol, fermented foods, deep-fried items, and excessive salt — all of which aggravate Pitta.

Lifestyle in Grishma classical texts prescribe: pre-dawn or early-morning exercise only, avoiding the midday sun (10 AM to 3 PM); cool baths; loose cotton clothing in light colours; rest during the hottest hours (one of the few seasons where a daytime nap of 30-45 minutes is sanctioned); coconut oil or sandalwood paste applied to the scalp and temples to cool the head; sleeping under a fan rather than under heavy blankets.

Pitta-prone patients should reduce intense physical labour, competitive sports in the heat, and emotionally heated conversations in summer — Pitta governs not only digestive fire but also the temperament, and overheated Pitta manifests as irritability, anger, and inflammatory complaints (rashes, acid reflux, headaches).

For mixed Pitta-Kapha constitutions, observe the Pitta-pacification protocol but include light bitter foods (bitter gourd, methi) which suit Kapha. For Vata-Pitta mixes, avoid astringency overload — keep some oils in the diet to prevent Vata's dryness from compounding the summer heat.

---id: seed-kapha-pacification-spring
topic: Kapha pacification during Vasanta (spring)
sources: Charaka Samhita Sutrasthana 6, Ashtanga Hridaya Sutrasthana 3
tags: kapha, vasanta, ritucharya, pacification, spring, diet, congestion
unreviewed: true

Vasanta (spring, roughly March to April) is the season of Kapha liquefaction. The Kapha that accumulated during Hemanta and Shishira begins to melt under the warming spring sun, often manifesting as congestion, sinus issues, allergic responses, sluggish digestion, and seasonal heaviness or fatigue. Classical texts identify Vasanta as the prime season for purification (panchakarma), specifically vamana (therapeutic emesis) for those constitutionally suited.

Diet in Vasanta should emphasise: pungent, bitter, and astringent tastes; light, dry, and warm foods; foods like barley, old rice (preferably one year stored), honey, dry ginger, turmeric, black pepper, neem; bitter greens (drumstick leaves, fenugreek, bitter gourd); warm soups and broths. Avoid: heavy dairy (milk, cheese, ice cream), wheat, deep-fried foods, fresh sweets, sticky foods like dates and bananas in excess, cold drinks. Honey is especially recommended in Vasanta — Charaka cites honey as the natural Kapha-pacifier of this season.

Lifestyle in Vasanta prescribes: early rising; vigorous exercise (the only season where heavy exertion is fully sanctioned); dry massage (udvartana) with chickpea or rye flour instead of oil massage; warm but not heavy clothing; avoiding daytime sleep (which aggravates Kapha most in this season).

For Kapha-prone patients, this is the most important season to follow ritucharya strictly — Kapha accumulated through winter and now liquefying can manifest as bronchitis, asthma exacerbations, allergic rhinitis, and lethargy if left unmanaged. For Pitta-Kapha mixes, balance the pungency with cooling bitters. For Vata-Kapha, observe lightness but don't strip away all oils — warm oil massage twice a week prevents Vata aggravation while reducing Kapha.

---id: seed-vata-monsoon-management
topic: Vata management during Varsha (monsoon)
sources: Charaka Samhita Sutrasthana 6, Bhavaprakasha Purvakhanda
tags: vata, varsha, monsoon, ritucharya, digestion, agni
unreviewed: true

Varsha (monsoon, roughly July to August) is one of the most challenging seasons in classical Ayurveda. The damp, cool, cloudy weather combined with the recent depletion of Grishma summer leaves Agni (digestive fire) weak and Vata aggravated. All three doshas can become disturbed but Vata aggravation typically predominates, with secondary Pitta accumulation building toward Sharad autumn.

Diet in Varsha emphasises rebuilding Agni: easy-to-digest foods like old rice, mung dal, vegetable soups, kichari; warm cooked meals over raw salads; ginger, black pepper, long pepper, and asafoetida liberally added; honey in small amounts to support digestion; barley water and rice gruel for fragile appetites; sour tastes like buttermilk and lemon (but in moderation) to stimulate hunger. Avoid: raw vegetables, leafy greens, cold drinks, river water (use boiled water only), heavy beans and lentils, and most fermented foods.

Lifestyle in Varsha includes: keeping warm and dry, especially the feet and head; daily oil massage (warm sesame); using a hat or umbrella whenever stepping out in rain; avoiding swimming or wading in muddy water; sleeping in a well-ventilated but not damp room; reducing exposure to wet clothes (change immediately on returning indoors).

This is the season when joint complaints — Sandhigata Vata, Amavata, Janubasti indications — most often flare. Patients with chronic knee, back, or shoulder pain should add daily warm oil massage to the affected joints and avoid air conditioning or fans blowing directly on those areas. Patients with weak digestion should consider light intermittent fasting once a week (one meal day) to allow Agni to recover.

---id: seed-agni-and-digestion
topic: Agni — the digestive fire, its types, signs of imbalance, and management
sources: Charaka Samhita Chikitsa 15, Sushruta Samhita Sutrasthana 35
tags: agni, digestion, ajirna, ama, doshas, classical
unreviewed: true

Agni in Ayurveda is the digestive and metabolic fire — the principle that transforms food, sensory impressions, and experiences into nourishment for the body and mind. Charaka identifies thirteen distinct Agnis (jatharagni, five bhutagnis for the elements, seven dhatvagnis for the tissues), but for everyday clinical use, the four classical states of jatharagni are most relevant.

The four states are: Sama Agni — balanced, the ideal; Vishama Agni — irregular, fluctuating, typical of Vata constitutions and aggravated Vata states; Tikshna Agni — sharp, intense, prone to over-digestion and hyperacidity, typical of Pitta constitutions; Manda Agni — slow, sluggish, typical of Kapha constitutions and overweight states.

Signs of Sama Agni: regular hunger at meal times, comfortable digestion without bloating or burning, formed but soft stools once or twice daily, steady energy, clear tongue, pleasant breath, restful sleep. Signs of Vishama Agni: erratic appetite (ravenous one day, none the next), bloating, gas, constipation alternating with loose stools, abdominal distension, dry skin, anxiety. Signs of Tikshna Agni: excessive hunger soon after eating, acid reflux, burning sensations, loose stools, irritability when meals are delayed, red tongue, bad breath. Signs of Manda Agni: heaviness after meals, sweet taste in the mouth, white coated tongue, fatigue after eating, slow bowel movements, mucus, weight gain despite normal appetite.

Management is opposite-quality: Vishama needs warmth, regularity, and oily-grounding foods; Tikshna needs cooling, milder spices, regular meals; Manda needs warming spices, light dry foods, longer gaps between meals. When Agni is severely disturbed, Ama (undigested toxic residue) accumulates, which is the root of most chronic disease in classical Ayurvedic theory.

---id: seed-adathodai-vasaka
topic: Adathodai (Vasaka) — uses, dose, and classical context
sources: Bhavaprakasha Nighantu Guduchyadi Varga, Charaka Samhita Chikitsa 18 (Kasa Chikitsa)
tags: adathodai, vasaka, adhatoda, respiratory, kasa, kapha, prescription, medication
unreviewed: true

Adathodai (Tamil), known in Sanskrit as Vasa or Vasaka (Adhatoda vasica), is one of the most widely used herbs in classical Ayurveda for respiratory complaints. Bhavaprakasha Nighantu classifies it under the Guduchyadi Varga of bitter herbs and lists its primary actions as kasahara (cough-suppressing), shvasahara (anti-asthmatic), and raktastambhana (haemostatic in respiratory bleeding).

The standard fresh juice (swarasa) preparation is 10-20 ml twice daily, typically morning and evening, often combined with honey to soften the bitter taste and direct the action toward the upper respiratory tract. Decoction (kashayam) and powder (churna) forms are also available; the IWIS pharmacy stocks the syrup form, which contains the equivalent active fraction in palatable dose, typically 1 teaspoon (5 ml) two to three times daily for adults.

Adathodai is indicated for: productive cough with thick or coloured sputum, mild to moderate bronchitis, allergic rhinitis with congestion, post-viral lingering cough, and as supportive therapy in asthma exacerbations. It pacifies Kapha and Pitta and is mildly Vata-aggravating in long-term use — so for chronic Vata-type dry cough it should be combined with demulcent herbs like Yashtimadhu (licorice).

Contraindications: pregnancy (vasicine alkaloids have uterine-stimulant properties — classical texts and modern pharmacology agree to avoid in pregnancy), known bleeding disorders, and prolonged use beyond 4-6 weeks without clinical review. Drug interactions: avoid concurrent use with anticoagulant medications without clinician oversight.

When taking Adathodai, patients should be advised: take after meals or with warm water to minimise gastric irritation; avoid cold drinks immediately before or after the dose; discontinue and consult if rash, severe nausea, or bleeding occurs.

---id: seed-triphala-classical
topic: Triphala — three myrobalans, classical uses, dose, and rasayana action
sources: Charaka Samhita Chikitsa 1 (Rasayana Adhyaya), Bhavaprakasha Nighantu Haritakyadi Varga
tags: triphala, haritaki, bibhitaki, amalaki, rasayana, digestion, constipation, prescription
unreviewed: true

Triphala is the classical preparation of three myrobalan fruits in equal parts: Haritaki (Terminalia chebula), Bibhitaki (Terminalia bellirica), and Amalaki (Emblica officinalis). Charaka Chikitsa Sthana 1 enumerates Triphala among the foremost rasayanas (rejuvenatives), particularly for long-term improvement of digestion, vision, complexion, and longevity.

The three component fruits balance the three doshas: Haritaki primarily addresses Vata with mild laxative and digestive-stimulant action; Bibhitaki addresses Kapha with mucolytic and bronchial-clearing properties; Amalaki addresses Pitta with cooling, sour, and antioxidant qualities, and is the highest natural source of stable vitamin C in classical materia medica.

Standard dose: 1 to 3 grams (approximately 1/4 to 3/4 teaspoon) of the powder, taken at bedtime with warm water, or 30 minutes before sleep. For mild constipation, the higher dose (3-5 g) at bedtime is appropriate. For long-term rasayana use, the lower dose (1-2 g) is sufficient. Modern tablet and capsule forms are dosed equivalently — usually 1-2 tablets of 500 mg at bedtime.

Indications: chronic mild constipation, sluggish digestion, post-prandial heaviness, age-related decline in eyesight (used as eye wash decoction), general weakness, post-illness recovery, and as a daily long-term tonic in adults from middle age onward. Triphala is also a foundational ingredient in many compound formulations.

Contraindications: pregnancy (Haritaki content stimulates the uterus), severe diarrhoea, severe dehydration, and acute febrile illness. Caution in patients on diabetes medication (mild blood-sugar-lowering effect) and in those with very weak Agni who may experience cramping at higher doses.

Patient guidance: start at the lower dose for two weeks before increasing; expect a mild softening of stools within 3-7 days; if loose stools occur, reduce the dose; long-term daily use is classically sanctioned but should be reviewed annually by a clinician.

---id: seed-nidra-sleep
topic: Nidra (sleep) in Ayurveda — types, importance, and management of insomnia
sources: Charaka Samhita Sutrasthana 21 (Ashtauninditiya Adhyaya), Ashtanga Hridaya Sutrasthana 7
tags: nidra, sleep, insomnia, anidra, vata, dinacharya, lifestyle
unreviewed: true

Nidra (sleep) is one of the three pillars (trayopastambha) of life in Ayurveda, alongside Ahara (food) and Brahmacharya (regulated lifestyle). Charaka Sutrasthana 21 states that proper sleep gives happiness, strength, virility, knowledge, and life itself; disturbed sleep produces the opposite — unhappiness, debility, illness, and shortened lifespan.

Classical Ayurveda recognises seven types of sleep by cause: Tamobhava (natural sleep at night from accumulated tamas), Shleshma-samudbhava (Kapha-induced heaviness sleep), Manah-shrama-sambhava (sleep from mental exertion), Sharira-shrama-sambhava (sleep from physical exertion), Agantuka (sleep from external causes like illness or trauma), Vyadhi-anuvartini (sleep accompanying chronic illness), and Ratri-svabhava-prabhava (sleep from the natural circadian rhythm of night). Of these, the last is the healthiest and most rejuvenating.

Insomnia (anidra) is primarily a Vata disorder in classical theory, with Pitta as a secondary cause when irritability and overactive thought dominate. Treatment principles include: abhyanga (oil massage), particularly with bhringaraj or brahmi oil to the scalp and feet; warm milk with nutmeg, cardamom, or saffron at bedtime; ashwagandha or jatamansi as nerve tonics; shirodhara (oil flow on the forehead) for stubborn cases; pranayama practices like Nadi Shodhana (alternate-nostril breathing) for 10 minutes before bed.

Lifestyle prescriptions: regular bedtime (ideally before 10 PM, when Pitta time of night begins and the body's natural wakefulness peaks); no heavy meals after 7 PM; avoiding screens, intense conversations, and stimulating media in the final hour before sleep; a calm, dim sleeping room; warm bath or warm-water foot soak before bed.

Daytime sleep (divaswapna) is classically forbidden except in summer (Grishma), for those very young, very elderly, exhausted, or convalescing — it otherwise aggravates Kapha and predisposes to obesity, lethargy, and chronic disease.

---id: seed-emergency-red-flags
topic: When Ayurvedic care should defer to allopathic medicine — emergency red flags
sources: Modern clinical Ayurvedic practice consensus
tags: emergency, red-flags, safety, allopathic-referral, contraindication
unreviewed: true

Ayurveda is a complete medical system, but classical and modern Ayurvedic practitioners both recognise that certain presentations require immediate allopathic or emergency-medicine intervention. The voice coach must not substitute Ayurvedic guidance for emergency care in these cases. The patient should be told clearly: "Please call your doctor immediately, or go to the nearest hospital emergency room or call 108."

Cardiovascular emergencies: sudden severe chest pain, especially radiating to the left arm, jaw, or back; palpitations with dizziness, breathlessness, or fainting; sudden severe shortness of breath at rest. These can indicate myocardial infarction or pulmonary embolism — minutes matter.

Neurological emergencies: sudden severe headache (the worst headache of one's life); sudden weakness or numbness on one side of the body; sudden difficulty speaking, understanding speech, or seeing; sudden severe dizziness with vomiting; first-ever seizure; loss of consciousness. These can indicate stroke, intracranial bleed, or other surgical neurological emergencies.

Respiratory emergencies: severe difficulty breathing; bluish lips or fingertips; inability to complete a sentence due to breathlessness; severe asthma attack not responding to usual inhaler; suspected airway obstruction (choking).

Trauma and bleeding: significant external bleeding that does not stop with pressure; suspected fractures or dislocations; head injury with loss of consciousness, vomiting, or confusion; major burns; suspected internal bleeding (severe abdominal pain with shock signs).

Acute abdomen: sudden severe abdominal pain, especially with rigidity, fever, vomiting, or signs of shock; severe vomiting blood; black tarry stools or fresh blood in stools in significant amounts.

Mental-health emergencies: active suicidal ideation, active self-harm, severe psychosis with risk to self or others. These need immediate psychiatric attention.

Obstetric: heavy bleeding in pregnancy; severe abdominal pain in pregnancy; reduced or absent foetal movements; suspected eclampsia (severe headache, visual changes, swelling, high BP).

Severe acute infection: high fever with rigors, stiff neck, photophobia (possible meningitis); rapidly spreading skin infection with fever; severe dehydration in young children.

In all these cases, the voice coach should bypass any Ayurvedic suggestion and route the patient to emergency care.

---id: seed-prakriti-overview
topic: Prakriti — constitutional types, their qualities, and clinical relevance
sources: Charaka Samhita Vimana 8 (Rogibhishakjitiyam), Sushruta Samhita Sharira 4
tags: prakriti, constitution, vata, pitta, kapha, classical, diagnosis
unreviewed: true

Prakriti is the constitutional type determined at conception, fixed for life, formed by the relative proportions of Vata, Pitta, and Kapha doshas at the moment of embryogenesis. Charaka Vimana 8 describes seven possible Prakriti combinations: single-dosha (Vata, Pitta, Kapha), two-dosha (Vata-Pitta, Pitta-Kapha, Vata-Kapha), and tri-doshic (Sama-prakriti, the rare ideal balance). The vast majority of individuals are two-dosha types.

Vata Prakriti: typically lean, light frame; dry skin and hair; cold extremities; quick, restless mind; creative and enthusiastic but anxious under stress; irregular appetite and digestion (Vishama Agni); light, easily disturbed sleep; speaks quickly; learns quickly but forgets quickly. Tends toward joint complaints, constipation, dry skin conditions, anxiety, insomnia.

Pitta Prakriti: medium build, well-proportioned; warm skin, often with moles or freckles; reddish or brownish hair, prone to early greying; sharp, intense, focused mind; ambitious and competitive; strong appetite and digestion (Tikshna Agni); sleeps moderately well but heat-sensitive; speaks precisely and sometimes sharply. Tends toward acid reflux, skin inflammations, headaches, irritability, premature greying or balding.

Kapha Prakriti: solid, well-built frame; smooth oily skin; thick lustrous hair; cool but not cold body temperature; calm, steady, methodical mind; slow to anger, slow to forget; steady appetite, slow digestion (Manda Agni); sleeps deeply and long. Tends toward weight gain, sinus congestion, lethargy, attachment-related emotional issues, slow recovery from illness.

Clinical relevance: every treatment in classical Ayurveda is modulated by Prakriti. The same disease in a Vata-Pitta patient and a Kapha patient receives different management because the underlying doshic balance, the response to medications, and the expected disease trajectory all differ. Diet, sleep recommendations, exercise intensity, oil choices for abhyanga, and even the time of day a medication is given are all Prakriti-dependent.

Patients should understand: Prakriti is not a disease label. It is the baseline. The clinical goal is not to change your Prakriti — that is impossible — but to keep your particular doshas in their natural proportion so that no Vikriti (current imbalance) accumulates.
