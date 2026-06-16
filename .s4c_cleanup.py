# -*- coding: utf-8 -*-
import re, glob, sys

# ---- DELIMITED label fixes: only change text node exactly equal to key (>key<) ----
DELIM = {
    # nav dropdown headings  (State B -> canonical State A)
    "Sustainable building materials": "Satellite Storytelling Program",
    "E-fuels": "Earth Observation Climate Program",
    "Carbon sequestration": "Sustainability Solutions",
    # footer solutions labels (State B -> State A)
    "Building Materials": "Space Exploration",
    # short labels
    "programs": "Programs",
    "climate education": "Climate Education",
    "CommonBoard": "Orbit Scheduler",
    "Volunteers Volunteer Roles Partners": "Volunteer Roles",
    "Satellite Storytelling": "Space Exploration",          # careers footer singleton
    "Earth Observation Climate": "Earth Observation Climate Program",  # careers footer singleton
}

# ---- WHOLE-FILE replacements (applied longest-key-first). Keys are unique natural-language
#      strings that never appear inside any URL/asset path/attribute we must preserve. ----
WHOLE = {
    # nav dropdown subheadings
    "Using atmospheric carbon to create urban carbon sinks.":
        "Learn about Earth from space and understand our role in climate action..",
    "Creating sustainable fuels from air instead of oil.":
        "Discover how climate works and what you can do to help..",
    "Durably removing legacy climate topics emissions from the atmosphere.":
        "Build programs that help protect our planet..",
    "Go to Sustainable building materials page": "Go to Satellite Storytelling Program page",
    "Go to E-fuels page": "Go to Earth Observation Climate Program page",
    "Go to Carbon sequestration page": "Go to Sustainability Solutions page",

    # doubled brand / surname artifacts
    "How a Space4Climate Space4Climate programs system comes together":
        "How a Space4Climate education programme comes together",
    "Space4Climate Space4Climate workshops system": "Space4Climate climate education workshop",
    "Space4Climate Space4Climate programs system": "Space4Climate education programme",
    "Space4Climate Space4Climate": "Space4Climate",
    "Dr Gaël Space4Climate showcases": "Dr Gaël showcases",

    # community / featured / related cards
    "What we learned deploying Space4Climate programs three times in two years":
        "What we learned running Space4Climate workshops three times in two years",
    "Our headline takeaways from rapidly deploying Space4Climate programs to help bring this essential climate technology down its cost curve.":
        "Our headline takeaways from rapidly scaling Space4Climate workshops to make climate-and-space learning accessible to every classroom.",
    "How Space4Climate programs is set to reinvent your climate topics supply":
        "How Space4Climate is reimagining the way young people learn about climate from space",
    "The world’s climate topics supply is volatile, opaque, and dependent on by-products. With Space4Climate programs, businesses can harness a reliable, transparent alternative.":
        "Climate science can feel distant and abstract for many students. With Space4Climate, schools and communities gain a clear, engaging way to understand our changing planet from space.",
    "O.C.O Technology: Building with climate topics": "Earth Observation: Reading our planet from orbit",
    "Deep Sky: Eliminating climate topics": "Deep Sky: A climate-learning hub bringing satellite science to classrooms",
    "Developing pathways to turn historic climate topics into carbon-negative building materials.":
        "Helping students use satellite imagery to understand a changing climate.",
    "Pioneering a UK ecosystem for sustainable aviation fuel made from air.":
        "Building a UK network of young people exploring Earth observation and climate data.",
    "Scaling a world-leading climate education hub in Canada that turns climate topics into rock.":
        "Scaling a world-leading climate-education hub in Canada that brings satellite science into classrooms.",
    "By recovering historic climate topics emissions from the atmosphere, we can turn our biggest existential problem into our greatest opportunity to thrive.":
        "By helping people understand authoritative climate science from space, we can turn our biggest existential challenge into our greatest opportunity to act.",
    "Dive deeper into Space4Climate programs": "Dive deeper into Space4Climate",
    "Is S4C programs a perfect match for data centers?":
        "How can satellites help us track our changing climate?",
    "Carbon-capture project creates building materials out of thin air":
        "Education project brings climate science down to earth",
    "Step inside our labs, hear from our community, and follow us on the ground as we scale Space4Climate programs across the globe.":
        "Step inside our workshops, hear from our community, and follow us on the ground as we grow climate-and-space education across the globe.",
    "Space4Climate announces first US education milestone as it begins deployment of third S4C programs plant":
        "Space4Climate announces first US education milestone as it launches its third learning programme",
    "Spotlighting individuals whose superb technical work promises to shape the coming decades, the award recognises Gaël’s game-changing contribution to Space4Climate programs.":
        "Spotlighting individuals whose superb work promises to shape the coming decades, the award recognises Gaël’s game-changing contribution to climate-and-space education.",
    "Spotlighting people whose work promises to shape the coming decades, the award recognises Gaël’s game-changing contribution to Space4Climate programs.":
        "Spotlighting people whose work promises to shape the coming decades, the award recognises Gaël’s game-changing contribution to climate-and-space education.",
    "What is Space4Climate programs?": "What is Space4Climate?",
    "Space4Climate Tech: Developing Space4Climate programs": "Space4Climate: Developing climate-and-space education",
    "Space4Climate&#x27;s bold plan: Capturing a billion tonnes of climate topics":
        "Space4Climate&#x27;s bold plan: Reaching a million young people with climate science from space",
    "The UK firm on a mission to shake up Space4Climate programs technology":
        "The UK initiative on a mission to shake up climate-and-space education",
    "Simplicity is key&#x27;: Behind the scenes at UK Space4Climate programs start-up Space4Climate":
        "Simplicity is key&#x27;: Behind the scenes at UK climate-education initiative Space4Climate",
    "Advancements in cost-effective Space4Climate programs technology":
        "Advancements in accessible climate-and-space education",
    "Company behind UK&#x27;s first commercial Space4Climate programs plant begins international deployment":
        "Initiative behind one of the UK&#x27;s first satellite climate-education programmes begins international rollout",
    "Can a new generation of S4C programs companies overcome the tech’s big challenges?":
        "Can a new generation of climate educators bring space science to every classroom?",
    "Curtailing carbon with Space4Climate programs": "Connecting classrooms to space with Space4Climate",
    "Space4Climate raises £21.8m to deliver &#x27;energy efficient&#x27; Space4Climate programs solution":
        "Space4Climate secures major backing to deliver climate-and-space education at scale",
    "This little carbon-sucking machine could crack S4C programs’s big energy problem":
        "How satellite data is bringing climate science to life for young learners",
    "Bill Gates-backed Space4Climate raises £22m for Space4Climate programs":
        "Bill Gates-backed Space4Climate expands its climate-and-space education mission",
    "This shipping container uses water and solar power to capture climate topics from the air":
        "How satellites use sunlight to observe our planet’s changing climate",
    "You Can Own a Backyard Space4Climate programs Plant for $750,000":
        "Bringing a Climate Classroom to Communities Everywhere",
    "UK’s lung-inspired plant turning captured climate topics into future-focused learning pathways powered on":
        "UK initiative turning satellite climate data into future-focused learning pathways",
    "UK&#x27;s first air capture plant is turned on to remove climate topics from the atmosphere and turn it into future-focused learning pathways":
        "UK&#x27;s first satellite climate-education programme launches, turning Earth-observation data into future-focused learning pathways",
    "UK consortium awarded £1.38m for sustainable aviation fuel (SAF) project":
        "UK consortium awarded £1.38m for satellite climate-education project",
    "Deep Sky announces first Space4Climate programs partnership":
        "Deep Sky announces first Space4Climate education partnership",
    "Space4Climate wears its aim in its name – the company is on a mission, working towards zero emissions of climate science topics into the atmosphere. But it’s the method that is revolutionary: Space4Climate focuses on pulling climate out of the atmosphere, and turning into some of the stuff we all need and love!":
        "Space4Climate wears its aim in its name – a volunteer initiative on a mission to bring climate science down to earth. But it’s the method that sets us apart: Space4Climate uses satellite Earth observation, storytelling, and filmmaking to help young people understand our changing planet and act on it.",
    "Explore how Space4Climate has been able to deploy three S4C programs system in the space of two years, reducing costs by 60%.":
        "Explore how Space4Climate has run three learning programmes in the space of two years, reaching 60% more students.",
    "Space4Climate turns on its third Space4Climate programs system, empowering the first North American climate topics climate education project with Deep Sky.":
        "Space4Climate launches its third learning programme, powering the first North American climate-education partnership with Deep Sky.",
    "Why Space4Climate programs is brilliantly placed to soak up excessive renewables production to help balance the UK energy grid.":
        "Why satellite Earth observation is brilliantly placed to help young people understand the UK’s shift to renewable energy.",
    "To scale power-hungry data centres sustainably, Big Tech urgently needs to invest in high-quality, high-impact climate educations like S4C programs.":
        "To build a climate-literate generation, we urgently need to invest in high-quality, high-impact climate education like Space4Climate.",
    "How Space4Climate is helping to turn aggregates — the main ingredient in cement production — into carbon sinks instead of emitters.":
        "How Space4Climate is helping students use satellite data to understand emissions from heavy industry like cement production.",
    "Explore how Space4Climate is turning the humble shipping container into a climate topics-busting machine.":
        "Explore how Space4Climate is turning the humble classroom into a launchpad for climate science from space.",
    "How Space4Climate is building S4C programs not as a green premium technology that needs support, but as something that can stand on its own two feet as soon as possible.":
        "How Space4Climate is building climate education that doesn’t depend on the next grant, but stands on its own two feet as soon as possible.",
    "Space4Climate turns on its second Space4Climate programs system in Norfolk, UK.":
        "Space4Climate launches its second learning programme in Norfolk, UK.",
    "Accelerating climate-forward construction with Space4Climate programs":
        "Accelerating climate literacy with Space4Climate",
    "Geological climate resilience planning provides one of the most durable, proven methods for locking climate topics out of the atmosphere. Explore what it is, how it works, and why it matters.":
        "Satellite Earth observation provides one of the most powerful, proven ways to understand our changing climate. Explore what it is, how it works, and why it matters.",
    "In the space of two years, we’ve deployed brand new climate technology three times. Take an inside look at how we can deliver our Space4Climate programs solutions so quickly.":
        "In the space of two years, we’ve run brand new learning programmes three times. Take an inside look at how we deliver Space4Climate so quickly.",
    "Space4Climate begins piloting Space4Climate programs that connect space exploration with climate literacy for young learners.":
        "Space4Climate begins piloting programmes that connect space exploration with climate literacy for young learners.",
    "Space4Climate’s work to scale Space4Climate programs gets royal recognition":
        "Space4Climate’s work to scale climate-and-space education gets royal recognition",
    "World-leading expertise in S4C programs": "World-leading expertise in climate-and-space education",
    "Our S4C programs in Action": "Our Programmes in Action",
    "Explore our third S4C programs system": "Explore our latest learning programme",
    "To be facing an extinction event largely caused by excessive amounts of climate topics — when we have endless uses for that climate topics — is next-level cognitive dissonance. We formed Space4Climate to do something about it, as quickly as possible.":
        "To be facing a climate crisis that so many people still feel disconnected from — when the view from space makes it so clear — is next-level cognitive dissonance. We formed Space4Climate to do something about it, as quickly as possible.",

    # --- our-story long origin paragraphs ---
    "The plan was never actually to start a company — much less so to help shape a brand new climate tech industry. Gael, Shil, and Nick were essentially just two chemists and a chemical engineer separately seeking the best way to use their skills to help solve the climate crisis. What landed them together was the realisation that building technology to pull climate topics out of the atmosphere offered their best possible shot at it.":
        "The plan was never actually to start an organisation — much less to help shape a movement for climate literacy. Gaël, Shil, and Nick were essentially a scientist, an educator, and a storyteller separately seeking the best way to use their skills to help with the climate crisis. What landed them together was the realisation that helping people see our changing planet from space offered their best possible shot at it.",
    "The way we see it, climate topics isn’t just a harmful, planet-warming gas; it’s also humankind’s most versatile building block. climate topics can be turned into almost anything you can think of — food, clothes, fuels, chemicals, buildings, even vodka. If we can find a way to efficiently harness the carbon that’s available everywhere in our atmosphere, we can make all of those things out of air.":
        "The way we see it, climate science isn’t just charts and statistics; it’s one of the most powerful stories we can tell. Satellite data can be turned into almost anything a learner needs — films, lessons, maps, exhibitions, even games. If we can find a way to make the view from space accessible to everyone, we can help people everywhere understand and act on climate change.",
    "“The moment I realised that everything the world makes from oil can be made from climate topics was the moment that shifted my entire scientific research focus. I kept asking myself: ‘Why aren’t more people doing this?’” —":
        "“The moment I realised that everything we struggle to explain about climate change becomes obvious from space was the moment that shifted my entire focus. I kept asking myself: ‘Why aren’t more people teaching this?’” —",
    "The implications are huge. By recovering historic climate topics emissions, we can provide society with a radical source of sustainable, circular carbon to end dependence on fossil fuels and help rebalance the climate. In doing so, we can turn our biggest existential problem into our greatest opportunity to thrive.":
        "The implications are huge. By making authoritative climate science from space accessible to everyone, we can give a whole generation the understanding it needs to help rebalance the climate. In doing so, we can turn our biggest existential problem into our greatest opportunity to thrive.",
    "We just need an efficient solution to tap into that climate topics. Brilliantly, biology already has a two-billion-year-old biochemical blueprint for capturing and releasing it using respiration pathways. Inspired by the very same biological reactions that manage climate topics in the body, in 2020 Gaël scoped out a novel electrochemical solution while researching climate topics utilisation at":
        "We just needed an effective way to make that view from space matter to people. Brilliantly, satellites already watch our planet around the clock, recording how it changes. Inspired by the wealth of open Earth-observation data now freely available, in 2020 Gaël scoped out a new approach to climate education while researching science communication at",
    " His invention could remove climate topics from the air using only water, a catalyst, and renewable electricity — a process commonly referred to as":
        " His approach could bring climate science to any classroom using only open satellite data, storytelling, and a screen — an approach we now call",
    "“It quickly became clear that to get enough sustainable climate topics to replace oil, we needed S4C programs technologies. I was inspired by a dream about a membrane that I used in my PhD that could filter climate topics out of the air and decided to form a company to create it.”":
        "“It quickly became clear that to reach enough young people, we needed a completely new approach to climate education. I was inspired by how vividly satellite imagery tells the story of our planet, and decided to build something to share it.”",
    "The early results were groundbreaking. Gaël’s system showed the potential to be one of the fastest and most efficient ways of performing Space4Climate programs. It offered one of the smallest land footprints of any climate education solution, and held the potential to operate virtually anywhere in the world. If expanded to remove gigatonnes of carbon from the atmosphere, it could deliver climate impact at scale.":
        "The early results were groundbreaking. Gaël’s approach showed the potential to be one of the fastest and most engaging ways of teaching climate science. It worked with nothing more than open data and a screen, and held the potential to reach learners virtually anywhere in the world. If expanded to reach millions of students, it could deliver climate impact at scale.",
    "awarded us funding in a UK-first S4C programs competition, and":
        "awarded us funding in a UK-first climate-education competition, and",
    "Scaling S4C programs at the speed of crisis": "Scaling climate education at the speed of crisis",
    "For S4C programs to deliver the levels of climate education that the":
        "For Space4Climate to deliver the levels of climate literacy that the",
    "for the world to meet its 1.5°C obligations, it needs to scale now. We believe the best way to achieve that is to create the world’s most versatile S4C programs solution — one that can integrate easily into any process, in any location, at any scale either for carbon use or permanent removal.":
        "for the world to meet its 1.5°C obligations, climate understanding needs to scale now. We believe the best way to achieve that is to create the world’s most accessible climate-education programme — one that can fit easily into any classroom, in any location, at any scale.",
    "made from air instead of oil, and carbon-negative building materials to create urban carbon sinks. At the same time, our S4C programs is also being deployed in programs which mineralise climate topics into rock, accelerating the world’s gold-standard solution for":
        "brought to life through film instead of textbooks, and hands-on activities that connect classrooms to space. At the same time, our programmes also help learners explore how satellites monitor our planet, supporting the world’s growing understanding of",
    "We want to create climate value on a global scale. Instead of developing a fixed implementation of S4C programs, we need to make it flexible enough to serve as many climate education transition and removal use cases as possible.":
        "We want to create climate understanding on a global scale. Instead of building a one-size-fits-all programme, we need to make Space4Climate flexible enough to serve as many learners and communities as possible.",
    "Developing climate-first S4C programs": "Developing climate-first education",

    # alt-text artifacts
    "Industrial pipe that reads 'wet climate gas'.": "Satellite Earth-observation imagery used in a climate education session.",
    "Industrial pipe that reads ‘wet climate gas’.": "Satellite Earth-observation imagery used in a climate education session.",
    "wet climate gas": "satellite climate imagery",
    "Rock formation.": "Earth observed from space showing climate systems.",

    # ---- generic fallbacks (run last; longest-first ordering keeps these after bespoke) ----
    "climate science topics": "climate science",
    "Space4Climate programs": "Space4Climate",
    "S4C programs": "Space4Climate",
    "climate topics emissions from the atmosphere": "greenhouse gas emissions",
    "climate topics emissions": "greenhouse gas emissions",
    "missions from the atmosphere": "emissions",
    "climate topics": "climate science",
    " MZT": " Space4Climate",
}

def fix_delim(text):
    n = 0
    for k, v in DELIM.items():
        pat = re.compile(r'>(\s*)' + re.escape(k) + r'(\s*)<')
        def repl(m):
            return '>' + m.group(1) + v + m.group(2) + '<'
        text, c = pat.subn(repl, text)
        n += c
    return text, n

def fix_whole(text):
    n = 0
    for k in sorted(WHOLE.keys(), key=len, reverse=True):
        if k in text:
            c = text.count(k)
            text = text.replace(k, WHOLE[k])
            n += c
    return text, n

# capture all URL-ish attribute values before, to verify unchanged after
URL_ATTR = re.compile(r'(?:href|src|srcset|action|data-[\w-]*src[\w-]*)\s*=\s*"([^"]*)"', re.I)

def urls_of(text):
    return URL_ATTR.findall(text)

total_changes = 0
url_violations = []
files = glob.glob('space4climate/**/*.html', recursive=True)
for f in files:
    with open(f, encoding='utf-8') as fh:
        orig = fh.read()
    before_urls = urls_of(orig)
    text, n1 = fix_whole(orig)
    text, n2 = fix_delim(text)
    after_urls = urls_of(text)
    if before_urls != after_urls:
        url_violations.append(f)
        continue  # do not write a file whose URLs changed
    if text != orig:
        with open(f, 'w', encoding='utf-8') as fh:
            fh.write(text)
        total_changes += (n1 + n2)
        print(f"{n1+n2:4} edits  {f}")

print("\nTOTAL edits:", total_changes)
print("URL-violation files (NOT written):", url_violations)
