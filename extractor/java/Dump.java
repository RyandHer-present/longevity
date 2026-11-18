package longevity.extract;

import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.*;

/**
 * Boots a vanilla Minecraft server's classes (no world, no network) and dumps the
 * values that only live in code: mob attributes, block hardness, item stats, fuel,
 * potions, brewing mixes, pre-1.21 enchantments and pre-26 villager trades.
 *
 * Every name goes through {@link R}, so the same program runs on obfuscated jars
 * (with Mojang's server mappings) and on the unobfuscated 26.x jars.
 *
 * Args: <mappings.txt or -> <out.json> <tags.tsv or ->
 * Output is raw; extractor/build.py turns it into the app's schema.
 */
public final class Dump {
    static final IdentityHashMap<Object, String> ids = new IdentityHashMap<>();
    static final Map<String, Object> registries = new LinkedHashMap<>(); // "item" -> Registry
    static final Map<String, Map<String, Object>> byId = new HashMap<>(); // "item" -> id -> entry
    static final List<String> errors = new ArrayList<>();
    static final List<String> notes = new ArrayList<>();

    public static void main(String[] a) throws Exception {
        long t0 = System.currentTimeMillis();
        R.load(a[0]);
        R.scall("net.minecraft.SharedConstants", "tryDetectVersion");
        R.scall("net.minecraft.server.Bootstrap", "bootStrap");
        indexRegistries();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("registries", registryLists());
        section(out, "entities", Dump::entities);
        section(out, "blocks", Dump::blocks);
        if (a.length > 2 && !a[2].equals("-")) {
            try { bindTags(a[2]); notes.add("tags bound"); }
            catch (Throwable t) { err("bindTags", t); }
        }
        section(out, "bind_components", Dump::bindComponents);
        section(out, "items", Dump::items);
        section(out, "fuel", Dump::fuel);
        section(out, "potions", Dump::potions);
        section(out, "effects", Dump::effects);
        section(out, "brewing", Dump::brewing);
        section(out, "enchantments", Dump::enchantments);
        section(out, "trades", Dump::trades);
        out.put("errors", errors);
        out.put("notes", notes);
        out.put("seconds", (System.currentTimeMillis() - t0) / 1000.0);

        try (Writer w = new OutputStreamWriter(new FileOutputStream(a[1]), StandardCharsets.UTF_8)) {
            Json.write(w, out);
        }
        System.out.println("dump ok: " + errors.size() + " errors");
        for (String e : errors) System.out.println("  ERR " + e.split("\n")[0]);
        System.exit(0);
    }

    interface Section { Object run() throws Exception; }

    static void section(Map<String, Object> out, String name, Section s) {
        try {
            Object v = s.run();
            if (v != null) out.put(name, v);
        } catch (Throwable t) { err(name, t); }
    }

    static void err(String where, Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        String msg = where + ": " + t;
        Throwable c = t.getCause();
        while (c != null) { msg += " <- " + c; c = c.getCause(); }
        errors.add(msg);
        System.err.println("ERROR in " + where);
        t.printStackTrace();
    }

    // ------------------------------------------------------------------ registries

    static void indexRegistries() throws Exception {
        Class<?> bir = R.cls("net.minecraft.core.registries.BuiltInRegistries");
        for (Field f : bir.getDeclaredFields()) {
            if (!Modifier.isStatic(f.getModifiers())) continue;
            f.setAccessible(true);
            Object reg = f.get(null);
            if (!(reg instanceof Iterable) || !R.hasMethod(reg, "key")) continue;
            String name = keyPath(R.call(reg, "key").toString());
            if (name == null || registries.containsKey(name)) continue;
            registries.put(name, reg);
            Map<String, Object> m = new LinkedHashMap<>();
            for (Object e : (Iterable<?>) reg) {
                Object k = R.call(reg, "getKey", e);
                if (k == null) continue;
                String id = k.toString();
                m.put(id, e);
                if (!ids.containsKey(e)) ids.put(e, id);
            }
            byId.put(name, m);
        }
    }

    /** "ResourceKey[minecraft:root / minecraft:item]" -> "item" */
    static String keyPath(String s) {
        String id = keyId(s);
        if (id == null) return null;
        return id.startsWith("minecraft:") ? id.substring(10) : id;
    }

    /** "ResourceKey[a / minecraft:zombie]" or "TagKey[a / b]" -> the second id */
    static String keyId(String s) {
        int slash = s.lastIndexOf(" / ");
        int end = s.lastIndexOf(']');
        if (slash < 0 || end < slash) return null;
        return s.substring(slash + 3, end);
    }

    static Object reg(String name) { return registries.get(name); }

    static Object vanillaFlags() { return R.sget("net.minecraft.world.flag.FeatureFlags", "DEFAULT_FLAGS"); }

    /** False for things behind an experiment (feature flag) that plain vanilla does not enable. */
    static boolean enabled(Object featureElement) {
        try { return (Boolean) R.call(featureElement, "isEnabled", vanillaFlags()); }
        catch (Throwable t) { return true; }
    }

    static Map<String, Object> registryLists() {
        Map<String, Object> out = new LinkedHashMap<>();
        for (String r : new String[]{"item", "block", "entity_type", "potion", "mob_effect", "enchantment",
                "villager_profession", "villager_type", "attribute"}) {
            if (byId.containsKey(r)) out.put(r, new ArrayList<>(byId.get(r).keySet()));
        }
        return out;
    }

    static Iterable<?> entries(String name) {
        Object r = reg(name);
        return r == null ? Collections.emptyList() : (Iterable<?>) r;
    }

    // ------------------------------------------------------------------ generic serializer

    static String enumName(Object o) {
        if (o == null) return null;
        if (R.hasMethod(o, "getSerializedName")) {
            Object n = R.call(o, "getSerializedName");
            if (n != null) return n.toString();
        }
        Enum<?> e = (Enum<?>) o;
        Class<?> ec = e.getDeclaringClass();
        for (Field f : ec.getDeclaredFields()) {
            if (!f.isEnumConstant()) continue;
            try { f.setAccessible(true); if (f.get(null) == o) return R.fieldName(f).toLowerCase(Locale.ROOT); }
            catch (Exception ignored) { }
        }
        return e.name().toLowerCase(Locale.ROOT);
    }

    static Object ser(Object o) { return ser(o, 0); }

    static Object ser(Object o, int depth) {
        if (o == null) return null;
        if (o instanceof String || o instanceof Boolean) return o;
        if (o instanceof Number) {
            if (o instanceof Double && (((Double) o).isNaN() || ((Double) o).isInfinite())) return null;
            if (o instanceof Float && (((Float) o).isNaN() || ((Float) o).isInfinite())) return null;
            return o;
        }
        if (o instanceof Character) return o.toString();
        String id = ids.get(o);
        if (id != null) return id;
        if (o instanceof Enum) return enumName(o);
        if (o instanceof Optional) return ser(((Optional<?>) o).orElse(null), depth);
        if (o instanceof OptionalInt) return ((OptionalInt) o).isPresent() ? ((OptionalInt) o).getAsInt() : null;
        String cn = R.named(o.getClass());
        if (cn.startsWith("net.minecraft.core.Holder$")) {
            try {
                Object k = R.call(o, "unwrapKey");
                if (k instanceof Optional && ((Optional<?>) k).isPresent()) return keyId(((Optional<?>) k).get().toString());
            } catch (Throwable ignored) { }
            try { return ser(R.call(o, "value"), depth); } catch (Throwable t) { return "<unbound holder>"; }
        }
        if (cn.equals("net.minecraft.resources.ResourceKey")) return keyId(o.toString());
        if (cn.equals("net.minecraft.tags.TagKey")) return "#" + keyId(o.toString());
        if (cn.equals("net.minecraft.resources.ResourceLocation") || cn.equals("net.minecraft.resources.Identifier")) return o.toString();
        if (cn.startsWith("net.minecraft.core.HolderSet$")) return serHolderSet(o, depth);
        if (cn.equals("net.minecraft.world.item.crafting.Ingredient")) return serIngredient(o);
        if (cn.equals("net.minecraft.world.item.ItemStack")) return serStack(o);
        if (cn.equals("net.minecraft.network.chat.Component") || cn.startsWith("net.minecraft.network.chat.MutableComponent")) return o.toString();
        if (cn.startsWith("org.apache.commons.lang3.tuple.")) {
            return Arrays.asList(ser(R.call(o, "getLeft"), depth + 1), ser(R.call(o, "getRight"), depth + 1));
        }
        if (cn.equals("com.mojang.datafixers.util.Pair")) {
            return Arrays.asList(ser(R.call(o, "getFirst"), depth + 1), ser(R.call(o, "getSecond"), depth + 1));
        }
        if (o instanceof Map) {
            Map<String, Object> m = new LinkedHashMap<>();
            for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
                Object k = ser(e.getKey(), depth + 1);
                m.put(String.valueOf(k), ser(e.getValue(), depth + 1));
            }
            return m;
        }
        if (o instanceof Collection) {
            List<Object> l = new ArrayList<>();
            for (Object x : (Collection<?>) o) l.add(ser(x, depth + 1));
            return l;
        }
        if (o.getClass().isArray()) {
            List<Object> l = new ArrayList<>();
            int n = Array.getLength(o);
            for (int i = 0; i < n; i++) l.add(ser(Array.get(o, i), depth + 1));
            return l;
        }
        if (o.getClass().isSynthetic() || o.getClass().isHidden() || o.getClass().getName().contains("$$Lambda")) return "<lambda>";
        if (!cn.startsWith("net.minecraft.") || depth > 6) return "<" + R.simpleOf(o.getClass()) + ">";
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("_type", typeName(o.getClass()));
        for (Class<?> k = o.getClass(); k != null && k != Object.class && k != Record.class; k = k.getSuperclass()) {
            for (Field f : k.getDeclaredFields()) {
                if (Modifier.isStatic(f.getModifiers()) || f.isSynthetic()) continue;
                String fname = R.fieldName(f);
                if (m.containsKey(fname)) continue;
                try {
                    f.setAccessible(true);
                    m.put(fname, ser(f.get(o), depth + 1));
                } catch (Throwable t) { m.put(fname, "<" + t.getClass().getSimpleName() + ">"); }
            }
        }
        return m;
    }

    /** "VillagerTrades$EmeraldForItems" style simple name. */
    static String typeName(Class<?> c) {
        if (c.isAnonymousClass()) c = c.getSuperclass();
        return R.simpleOf(c);
    }

    static Object serHolderSet(Object hs, int depth) {
        String cn = R.named(hs.getClass());
        if (cn.endsWith("$Named")) {
            Object key = R.call(hs, "key");
            return "#" + keyId(key.toString());
        }
        List<Object> l = new ArrayList<>();
        try {
            Object stream = R.call(hs, "stream");
            for (Object h : ((Stream<?>) stream).collect(Collectors.toList())) l.add(ser(h, depth + 1));
        } catch (Throwable t) { l.add("<holderset " + t + ">"); }
        return l;
    }

    static List<Object> serIngredient(Object ing) {
        List<Object> out = new ArrayList<>();
        Object values = R.getOr(ing, "values", null);
        if (values == null) {
            out.add("<ingredient>");
            return out;
        }
        if (values.getClass().isArray()) {
            for (int i = 0; i < Array.getLength(values); i++) {
                Object v = Array.get(values, i);
                Object tag = R.getOr(v, "tag", null);
                if (tag != null) { out.add(ser(tag)); continue; }
                Object item = R.getOr(v, "item", null);
                if (item != null) {
                    Object s = ser(item);
                    out.add(s instanceof Map ? ((Map<?, ?>) s).get("item") : s);
                    continue;
                }
                out.add(ser(v));
            }
            return out;
        }
        Object s = ser(values);
        if (s instanceof List) out.addAll((List<?>) s); else out.add(s);
        return out;
    }

    static Map<String, Object> serStack(Object stack) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("item", ser(R.call(stack, "getItem")));
        m.put("count", R.call(stack, "getCount"));
        return m;
    }

    // ------------------------------------------------------------------ entities

    static Object entities() {
        Map<String, Object> out = new LinkedHashMap<>();
        Map<?, ?> suppliers = (Map<?, ?>) R.sget("net.minecraft.world.entity.ai.attributes.DefaultAttributes", "SUPPLIERS");
        for (Object et : entries("entity_type")) {
            Map<String, Object> e = new LinkedHashMap<>();
            if (!enabled(et)) e.put("experimental", true);
            e.put("category", enumName(R.call(et, "getCategory")));
            e.put("lang", R.call(et, "getDescriptionId"));
            try { e.put("loot", ser(R.call(et, "getDefaultLootTable"))); } catch (Throwable t) { e.put("loot", null); }
            try {
                Object dim = R.call(et, "getDimensions");
                e.put("width", ser(R.get(dim, "width")));
                e.put("height", ser(R.get(dim, "height")));
            } catch (Throwable ignored) { }
            e.put("fire_immune", R.call(et, "fireImmune"));
            e.put("summonable", R.call(et, "canSummon"));
            Object sup = suppliers.get(et);
            if (sup != null) {
                Map<String, Object> attrs = new LinkedHashMap<>();
                Map<?, ?> inst = (Map<?, ?>) R.get(sup, "instances");
                for (Map.Entry<?, ?> x : inst.entrySet()) {
                    attrs.put(String.valueOf(ser(x.getKey())), R.call(x.getValue(), "getBaseValue"));
                }
                e.put("attributes", attrs);
            }
            out.put(ids.get(et), e);
        }
        return out;
    }

    // ------------------------------------------------------------------ blocks

    static Object blocks() {
        Map<String, Object> out = new LinkedHashMap<>();
        Object fire = byId.get("block").get("minecraft:fire");
        Map<?, ?> ignite = (Map<?, ?>) R.getOr(fire, "igniteOdds", null);
        Map<?, ?> burn = (Map<?, ?>) R.getOr(fire, "burnOdds", null);
        if (ignite == null) notes.add("FireBlock.igniteOdds missing");
        for (Object b : entries("block")) {
            Map<String, Object> e = new LinkedHashMap<>();
            Object st = R.call(b, "defaultBlockState");
            if (!enabled(b)) e.put("experimental", true);
            e.put("lang", R.call(b, "getDescriptionId"));
            e.put("hardness", ser(R.get(st, "destroySpeed")));
            e.put("blast", ser(R.call(b, "getExplosionResistance")));
            e.put("light", ser(R.hasField(st, "lightEmission") ? R.get(st, "lightEmission") : R.call(st, "getLightEmission")));
            e.put("requires_tool", R.call(st, "requiresCorrectToolForDrops"));
            try { e.put("loot", ser(R.call(b, "getLootTable"))); } catch (Throwable t) { e.put("loot", null); }
            e.put("friction", ser(R.call(b, "getFriction")));
            e.put("speed_factor", ser(R.call(b, "getSpeedFactor")));
            e.put("jump_factor", ser(R.call(b, "getJumpFactor")));
            Object item = R.call(b, "asItem");
            e.put("item", ser(item));
            if (ignite != null) {
                Object io = ignite.get(b), bo = burn.get(b);
                e.put("ignite_odds", io == null ? 0 : io);
                e.put("burn_odds", bo == null ? 0 : bo);
            }
            try { e.put("lava_ignites", R.call(st, "ignitedByLava")); } catch (Throwable ignored) { }
            out.put(ids.get(b), e);
        }
        return out;
    }

    // ------------------------------------------------------------------ tags

    /** tags.tsv lines: registry \t tag id \t space separated entry ids (already expanded). */
    static void bindTags(String path) throws Exception {
        Map<String, Map<String, List<String>>> all = new LinkedHashMap<>();
        for (String line : Files.readAllLines(Paths.get(path), StandardCharsets.UTF_8)) {
            String[] p = line.split("\t", -1);
            if (p.length < 3) continue;
            all.computeIfAbsent(p[0], k -> new LinkedHashMap<>())
               .put(p[1], p[2].isEmpty() ? Collections.emptyList() : Arrays.asList(p[2].split(" ")));
        }
        String rlClass = R.has("net.minecraft.resources.ResourceLocation") ? "net.minecraft.resources.ResourceLocation" : "net.minecraft.resources.Identifier";
        for (Map.Entry<String, Map<String, List<String>>> re : all.entrySet()) {
            Object reg = reg(re.getKey());
            if (reg == null) continue;
            Object regKey = R.call(reg, "key");
            Map<Object, List<Object>> m = new LinkedHashMap<>();
            for (Map.Entry<String, List<String>> te : re.getValue().entrySet()) {
                Object tk = R.scall("net.minecraft.tags.TagKey", "create", regKey, R.scall(rlClass, "tryParse", te.getKey()));
                List<Object> holders = new ArrayList<>();
                for (String id : te.getValue()) {
                    Object v = byId.get(re.getKey()).get(id);
                    if (v != null) holders.add(R.call(reg, "wrapAsHolder", v));
                }
                m.put(tk, holders);
            }
            boolean done = false;
            Throwable first = null;
            if (R.has("net.minecraft.tags.TagLoader$LoadResult") && R.hasMethod(reg, "prepareTagReload", R.construct("net.minecraft.tags.TagLoader$LoadResult", regKey, new HashMap<>()))) {
                try {
                    Object lr = R.construct("net.minecraft.tags.TagLoader$LoadResult", regKey, m);
                    Object pending = R.call(reg, "prepareTagReload", lr);
                    R.call(pending, "apply");
                    done = true;
                } catch (Throwable t) { first = t; }
            }
            if (!done && R.hasMethod(reg, "bindTags", m)) {
                R.call(reg, "bindTags", m);
                done = true;
            }
            if (!done) throw new RuntimeException("could not bind " + re.getKey() + " tags", first);
        }
    }

    // ------------------------------------------------------------------ items

    /**
     * 26.x builds item components lazily from data-driven registries. Do what the
     * data generator does: build the vanilla registry lookups from code, then run
     * the component initializers against them.
     */
    static Object bindComponents() {
        Object inits = R.sgetOrNull("net.minecraft.core.registries.BuiltInRegistries", "DATA_COMPONENT_INITIALIZERS");
        if (inits == null) return null;
        String vr = "net.minecraft.data.registries.VanillaRegistries";
        Object world, provider;
        String used;
        if (R.hasStatic(vr, "createWorldLookup")) {
            world = R.scall(vr, "createWorldLookup");
            provider = world;
            used = "world";
            try { provider = R.scall(vr, "createReloadableLookup", world); used = "world+reloadable"; }
            catch (Throwable t) { notes.add("reloadable lookup failed: " + t); }
        } else {
            world = provider = R.scall(vr, "createLookup");
            used = "vanilla";
        }
        List<?> pending;
        try { pending = (List<?>) R.call(inits, "build", provider); }
        catch (Throwable t) {
            if (provider == world) throw t;
            notes.add("component init on reloadable failed, retry world: " + t);
            pending = (List<?>) R.call(inits, "build", world);
            used = "world";
        }
        for (Object p : pending) R.call(p, "apply");
        notes.add("components bound from " + used + " lookup");
        return used;
    }

    static Object comp(String name) { return R.sgetOrNull("net.minecraft.core.component.DataComponents", name); }

    static Object getComp(Object stack, String name) {
        Object type = comp(name);
        if (type == null) return null;
        return R.call(stack, "get", type);
    }

    static Object items() {
        Map<String, Object> out = new LinkedHashMap<>();
        boolean components = R.has("net.minecraft.core.component.DataComponents");
        List<Object> allItems = new ArrayList<>();
        for (Object it : entries("item")) allItems.add(it);
        Map<Object, Object> stacks = new IdentityHashMap<>();
        for (Object it : allItems) stacks.put(it, R.call(it, "getDefaultInstance"));
        Object slotMain = R.sget("net.minecraft.world.entity.EquipmentSlot", "MAINHAND");
        Object[] slots = R.cls("net.minecraft.world.entity.EquipmentSlot").getEnumConstants();

        for (Object it : allItems) {
            Map<String, Object> e = new LinkedHashMap<>();
            Object stack = stacks.get(it);
            String id = ids.get(it);
            try {
                if (!enabled(it)) e.put("experimental", true);
                e.put("lang", R.call(it, "getDescriptionId"));
                e.put("stack", R.call(stack, "getMaxStackSize"));
                e.put("durability", R.call(stack, "getMaxDamage"));
                e.put("rarity", enumName(R.call(stack, "getRarity")));

                // food
                Object food = components ? getComp(stack, "FOOD") : R.call(it, "getFoodProperties");
                if (food != null) {
                    Map<String, Object> f = new LinkedHashMap<>();
                    int nut = ((Number) ser(R.hasField(food, "nutrition") ? R.get(food, "nutrition") : R.call(food, "getNutrition"))).intValue();
                    f.put("nutrition", nut);
                    if (R.hasField(food, "saturation")) f.put("saturation", R.get(food, "saturation"));
                    else {
                        float mod = ((Number) R.get(food, "saturationModifier")).floatValue();
                        f.put("saturation_modifier", mod);
                        f.put("saturation", nut * mod * 2.0f);
                    }
                    for (String k : new String[]{"canAlwaysEat", "isMeat", "fastFood", "eatSeconds"}) {
                        if (R.hasField(food, k)) f.put(k, ser(R.get(food, k)));
                    }
                    if (R.hasField(food, "effects")) f.put("effects", serEffects(R.get(food, "effects")));
                    e.put("food", f);
                }

                // attribute modifiers
                List<Object> mods = new ArrayList<>();
                if (components) {
                    Object iam = getComp(stack, "ATTRIBUTE_MODIFIERS");
                    // 1.20.5-1.21.1: armor and some tools keep their modifiers on the Item, not the component
                    if ((iam == null || ((List<?>) R.call(iam, "modifiers")).isEmpty()) && R.hasMethod(it, "getDefaultAttributeModifiers")) {
                        iam = R.call(it, "getDefaultAttributeModifiers");
                    }
                    if (iam != null) {
                        for (Object entry : (List<?>) R.call(iam, "modifiers")) {
                            Object mod = R.get(entry, "modifier");
                            Map<String, Object> m = new LinkedHashMap<>();
                            m.put("attr", ser(R.get(entry, "attribute")));
                            m.put("amount", R.get(mod, "amount"));
                            m.put("op", enumName(R.get(mod, "operation")));
                            m.put("slot", enumName(R.get(entry, "slot")));
                            mods.add(m);
                        }
                    }
                } else {
                    for (Object slot : slots) {
                        Object mm = R.call(it, "getDefaultAttributeModifiers", slot);
                        Collection<?> entries = (Collection<?>) R.call(mm, "entries");
                        for (Object x : entries) {
                            Map.Entry<?, ?> me = (Map.Entry<?, ?>) x;
                            Map<String, Object> m = new LinkedHashMap<>();
                            m.put("attr", ser(me.getKey()));
                            Object mod = me.getValue();
                            m.put("amount", R.get(mod, "amount"));
                            m.put("op", enumName(R.get(mod, "operation")));
                            m.put("slot", enumName(slot));
                            mods.add(m);
                        }
                    }
                    // <=1.20.4 horse armor: protection is a plain int on HorseArmorItem, not a modifier
                    if (R.hasMethod(it, "getProtection")) {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("attr", "minecraft:generic.armor");
                        m.put("amount", R.call(it, "getProtection"));
                        m.put("op", "addition");
                        m.put("slot", "body");
                        mods.add(m);
                    }
                }
                if (!mods.isEmpty()) e.put("modifiers", mods);

                // enchantability
                if (R.hasMethod(it, "getEnchantmentValue")) e.put("enchantable", R.call(it, "getEnchantmentValue"));
                else {
                    Object ench = getComp(stack, "ENCHANTABLE");
                    e.put("enchantable", ench == null ? 0 : R.get(ench, "value"));
                }

                // repair materials
                Object rep = components ? getComp(stack, "REPAIRABLE") : null;
                if (rep != null) {
                    e.put("repair", ser(R.get(rep, "items")));
                } else if (comp("REPAIRABLE") == null && ((Number) e.get("durability")).intValue() > 0
                        && R.hasMethod(it, "isValidRepairItem", stack, stack)) {
                    List<Object> r = new ArrayList<>();
                    for (Object other : allItems) {
                        if (other == it && !id.equals("minecraft:elytra")) { /* self-repair is the crafting recipe, not anvil */ }
                        if ((Boolean) R.call(it, "isValidRepairItem", stack, stacks.get(other))) r.add(ids.get(other));
                    }
                    e.put("repair", r);
                }

                if (components) {
                    Map<String, Object> extra = new LinkedHashMap<>();
                    for (String c : new String[]{"FIRE_RESISTANT", "DAMAGE_RESISTANT", "TOOL", "WEAPON", "CONSUMABLE",
                            "EQUIPPABLE", "COOKING_FUEL", "BREWING_FUEL", "DEATH_PROTECTION", "GLIDER", "USE_COOLDOWN",
                            "VILLAGER_FOOD", "BLOCKS_ATTACKS"}) {
                        Object type = comp(c);
                        if (type == null) continue;
                        Object v = R.call(stack, "get", type);
                        if (v != null) extra.put(c.toLowerCase(Locale.ROOT), ser(v));
                        else if (c.equals("FIRE_RESISTANT") && (Boolean) R.call(stack, "has", type)) extra.put("fire_resistant", true);
                    }
                    if (!extra.isEmpty()) e.put("components", extra);
                } else {
                    try { if ((Boolean) R.call(it, "isFireResistant")) e.put("components", Collections.singletonMap("fire_resistant", true)); }
                    catch (Throwable ignored) { }
                }
            } catch (Throwable t) {
                if (errors.size() < 40) err("item " + id, t);
            }
            out.put(id, e);
        }
        return out;
    }

    static List<Object> serEffects(Object effects) {
        List<Object> out = new ArrayList<>();
        for (Object x : (Collection<?>) effects) {
            Object inst = x, chance = null;
            String cn = R.named(x.getClass());
            if (cn.equals("com.mojang.datafixers.util.Pair")) { inst = R.call(x, "getFirst"); chance = R.call(x, "getSecond"); }
            else if (R.hasField(x, "effectSupplier")) { inst = R.call(x, "effect"); chance = R.get(x, "probability"); }
            else if (R.hasField(x, "probability")) { inst = R.get(x, "effect"); chance = R.get(x, "probability"); }
            if (inst instanceof java.util.function.Supplier) inst = ((java.util.function.Supplier<?>) inst).get();
            List<Object> e = new ArrayList<>(effectTriple(inst));
            if (chance != null) e.add(chance);
            out.add(e);
        }
        return out;
    }

    static List<Object> effectTriple(Object inst) {
        return Arrays.asList(ser(R.call(inst, "getEffect")), R.call(inst, "getDuration"), R.call(inst, "getAmplifier"));
    }

    // ------------------------------------------------------------------ fuel

    static Object fuel() {
        Map<String, Object> out = new LinkedHashMap<>();
        if (R.hasStatic("net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity", "getFuel")) {
            Map<?, ?> m = (Map<?, ?>) R.scall("net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity", "getFuel");
            for (Map.Entry<?, ?> e : m.entrySet()) out.put(ids.get(e.getKey()), e.getValue());
            return out;
        }
        if (R.has("net.minecraft.world.level.block.entity.FuelValues")) {
            List<Object> lookups = new ArrayList<>();
            for (String r : new String[]{"item", "block"}) lookups.add(reg(r));
            Object provider = R.scall("net.minecraft.core.HolderLookup$Provider", "create", lookups.stream());
            Object flags = vanillaFlags();
            Object fv = R.scall("net.minecraft.world.level.block.entity.FuelValues", "vanillaBurnTimes", provider, flags);
            Map<?, ?> m = (Map<?, ?>) R.get(fv, "values");
            for (Map.Entry<?, ?> e : m.entrySet()) out.put(ids.get(e.getKey()), e.getValue());
            return out;
        }
        notes.add("fuel: data-driven (item cooking_fuel component)");
        return null;
    }

    // ------------------------------------------------------------------ potions / effects / brewing

    static Object potions() {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Object p : entries("potion")) {
            Map<String, Object> e = new LinkedHashMap<>();
            if (!enabled(p)) e.put("experimental", true);
            Object name = R.getOr(p, "name", null);
            e.put("name", ser(name));
            List<Object> effs = new ArrayList<>();
            for (Object inst : (Collection<?>) R.call(p, "getEffects")) effs.add(effectTriple(inst));
            e.put("effects", effs);
            out.put(ids.get(p), e);
        }
        return out;
    }

    static Object effects() {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Object m : entries("mob_effect")) {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("lang", R.call(m, "getDescriptionId"));
            e.put("category", enumName(R.call(m, "getCategory")));
            Object inst = R.tryCall(m, new String[]{"isInstantenous", "isInstantaneous", "isInstant"});
            if (inst != R.NONE) e.put("instant", inst);
            out.put(ids.get(m), e);
        }
        return out;
    }

    static Object brewing() {
        String pb = "net.minecraft.world.item.alchemy.PotionBrewing";
        if (!R.has(pb)) { notes.add("brewing: data-driven recipes"); return null; }
        Map<String, Object> out = new LinkedHashMap<>();
        if (R.field(R.cls(pb), "POTION_MIXES") != null) {
            out.put("mixes", serMixes(R.sget(pb, "POTION_MIXES")));
            out.put("container_mixes", serMixes(R.sget(pb, "CONTAINER_MIXES")));
            out.put("containers", ser(R.sget(pb, "ALLOWED_CONTAINERS")));
        } else {
            Object brewing = R.scall(pb, "bootstrap", vanillaFlags());
            out.put("mixes", serMixes(R.get(brewing, "potionMixes")));
            out.put("container_mixes", serMixes(R.get(brewing, "containerMixes")));
            out.put("containers", ser(R.get(brewing, "containers")));
        }
        return out;
    }

    static List<Object> serMixes(Object list) {
        List<Object> out = new ArrayList<>();
        for (Object mix : (Collection<?>) list) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("input", ser(R.get(mix, "from")));
            m.put("ingredient", serIngredient(R.get(mix, "ingredient")));
            m.put("output", ser(R.get(mix, "to")));
            out.add(m);
        }
        return out;
    }

    // ------------------------------------------------------------------ enchantments (pre data-driven)

    static Object enchantments() {
        if (reg("enchantment") == null) { notes.add("enchantments: data-driven"); return null; }
        Map<String, Object> out = new LinkedHashMap<>();
        List<Object> allItems = new ArrayList<>();
        for (Object it : entries("item")) allItems.add(it);
        List<Object> stacks = new ArrayList<>();
        for (Object it : allItems) stacks.add(R.call(it, "getDefaultInstance"));
        List<Object> enchants = new ArrayList<>();
        for (Object en : entries("enchantment")) enchants.add(en);
        for (Object en : enchants) {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("lang", R.call(en, "getDescriptionId"));
            int max = (Integer) R.call(en, "getMaxLevel");
            e.put("max_level", max);
            e.put("min_level", R.call(en, "getMinLevel"));
            if (R.hasMethod(en, "getWeight")) e.put("weight", R.call(en, "getWeight"));
            else {
                Object rarity = R.call(en, "getRarity");
                e.put("rarity", enumName(rarity));
                e.put("weight", R.call(rarity, "getWeight"));
            }
            if (R.hasMethod(en, "getAnvilCost")) e.put("anvil_cost", R.call(en, "getAnvilCost"));
            List<Object> minC = new ArrayList<>(), maxC = new ArrayList<>();
            for (int l = 1; l <= max; l++) { minC.add(R.call(en, "getMinCost", l)); maxC.add(R.call(en, "getMaxCost", l)); }
            e.put("min_cost_levels", minC);
            e.put("max_cost_levels", maxC);
            e.put("treasure", R.call(en, "isTreasureOnly"));
            e.put("tradeable", R.call(en, "isTradeable"));
            e.put("curse", R.call(en, "isCurse"));
            e.put("discoverable", R.call(en, "isDiscoverable"));
            List<Object> sup = new ArrayList<>(), prim = new ArrayList<>();
            Object category = R.getOr(en, "category", null);
            for (int i = 0; i < allItems.size(); i++) {
                Object it = allItems.get(i), st = stacks.get(i);
                boolean can = (Boolean) R.call(en, "canEnchant", st);
                if (can) sup.add(ids.get(it));
                boolean primary;
                if (category != null) primary = (Boolean) R.call(category, "canEnchant", it);
                // 1.20.5/1.20.6: the table needs canEnchant && isPrimaryItem (isPrimaryItem is true for every item
                // when the enchantment has no primary tag)
                else if (R.hasMethod(en, "isPrimaryItem", st)) primary = can && (Boolean) R.call(en, "isPrimaryItem", st);
                else primary = false;
                if (primary) prim.add(ids.get(it));
            }
            if (category != null) e.put("category", enumName(category));
            e.put("supported", sup);
            e.put("primary", prim);
            List<Object> excl = new ArrayList<>();
            for (Object other : enchants) {
                if (other == en) continue;
                if (!(Boolean) R.call(en, "isCompatibleWith", other)) excl.add(ids.get(other));
            }
            e.put("exclusive", excl);
            List<Object> slots = new ArrayList<>();
            Object sl = R.getOr(en, "slots", null);
            if (sl == null) { Object def = R.getOr(en, "definition", null); if (def != null) sl = R.getOr(def, "slots", null); }
            if (sl != null) e.put("slots", ser(sl));
            out.put(ids.get(en), e);
        }
        return out;
    }

    // ------------------------------------------------------------------ trades (pre data-driven)

    static Object trades() {
        String vt = null;
        for (String c : new String[]{"net.minecraft.world.entity.npc.villager.VillagerTrades", "net.minecraft.world.entity.npc.VillagerTrades"}) {
            if (R.has(c) && R.field(R.cls(c), "TRADES") != null) { vt = c; break; }
        }
        if (vt == null) { notes.add("trades: not in code"); return null; }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("villager", ser(R.sget(vt, "TRADES")));
        out.put("wandering_trader", ser(R.sget(vt, "WANDERING_TRADER_TRADES")));
        Object exp = R.sgetOrNull(vt, "EXPERIMENTAL_TRADES");
        if (exp != null) out.put("experimental_villager", ser(exp));
        Object expW = R.sgetOrNull(vt, "EXPERIMENTAL_WANDERING_TRADER_TRADES");
        if (expW != null) out.put("experimental_wandering_trader", ser(expW));
        return out;
    }
}

final class Json {
    static void write(Writer w, Object o) throws IOException {
        if (o == null) { w.write("null"); return; }
        if (o instanceof String) { str(w, (String) o); return; }
        if (o instanceof Boolean) { w.write(o.toString()); return; }
        if (o instanceof Float || o instanceof Double) {
            double d = ((Number) o).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) { w.write("null"); return; }
            if (o instanceof Float) {
                // shortest decimal that round-trips the float
                String s = Float.toString((Float) o);
                if (s.contains("E")) s = new java.math.BigDecimal(s).toPlainString();
                if (s.endsWith(".0")) s = s.substring(0, s.length() - 2);
                w.write(s);
            } else {
                if (d == Math.rint(d) && Math.abs(d) < 1e15) w.write(Long.toString((long) d));
                else w.write(Double.toString(d));
            }
            return;
        }
        if (o instanceof Number) { w.write(o.toString()); return; }
        if (o instanceof Map) {
            w.write('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
                if (!first) w.write(',');
                first = false;
                str(w, String.valueOf(e.getKey()));
                w.write(':');
                write(w, e.getValue());
            }
            w.write('}');
            return;
        }
        if (o instanceof Collection) {
            w.write('[');
            boolean first = true;
            for (Object x : (Collection<?>) o) {
                if (!first) w.write(',');
                first = false;
                write(w, x);
            }
            w.write(']');
            return;
        }
        str(w, o.toString());
    }

    static void str(Writer w, String s) throws IOException {
        w.write('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': w.write("\\\""); break;
                case '\\': w.write("\\\\"); break;
                case '\n': w.write("\\n"); break;
                case '\r': w.write("\\r"); break;
                case '\t': w.write("\\t"); break;
                default:
                    if (c < 0x20) w.write(String.format("\\u%04x", (int) c));
                    else w.write(c);
            }
        }
        w.write('"');
    }
}
