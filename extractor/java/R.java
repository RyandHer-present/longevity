package longevity.extract;

import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/**
 * Reflection by Mojang names. For obfuscated jars it translates class, field and
 * method names through Mojang's official ProGuard server mappings; for the
 * unobfuscated 26.x jars it is a plain pass-through.
 */
final class R {
    static final Map<String, String> n2o = new HashMap<>();
    static final Map<String, String> o2n = new HashMap<>();
    static final Map<String, Map<String, String>> fields = new HashMap<>();
    static final Map<String, List<String[]>> methods = new HashMap<>(); // {name, obf, csv params}
    static final Map<String, Map<String, String>> fieldsRev = new HashMap<>(); // named class -> obf -> named
    static boolean mapped = false;
    static ClassLoader loader = R.class.getClassLoader();

    static void load(String path) throws IOException {
        if (path == null || path.isEmpty() || path.equals("-")) return;
        mapped = true;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(path), StandardCharsets.UTF_8))) {
            String line, cur = null;
            while ((line = r.readLine()) != null) {
                if (line.startsWith("#") || line.isEmpty()) continue;
                if (!line.startsWith(" ")) {
                    int a = line.indexOf(" -> ");
                    cur = line.substring(0, a);
                    String obf = line.substring(a + 4, line.length() - 1);
                    n2o.put(cur, obf);
                    o2n.put(obf, cur);
                    continue;
                }
                String l = line.trim();
                int arrow = l.indexOf(" -> ");
                String left = l.substring(0, arrow), obf = l.substring(arrow + 4);
                int paren = left.indexOf('(');
                if (paren < 0) { // field
                    String name = left.substring(left.indexOf(' ') + 1);
                    fields.computeIfAbsent(cur, k -> new HashMap<>()).put(name, obf);
                    fieldsRev.computeIfAbsent(cur, k -> new HashMap<>()).put(obf, name);
                } else {
                    String head = left.substring(0, paren);
                    head = head.replaceFirst("^\\d+:\\d+:", "");
                    String name = head.substring(head.lastIndexOf(' ') + 1);
                    String params = left.substring(paren + 1, left.indexOf(')'));
                    methods.computeIfAbsent(cur, k -> new ArrayList<>()).add(new String[]{name, obf, params});
                }
            }
        }
    }

    static String obfClass(String named) { return mapped ? n2o.getOrDefault(named, named) : named; }
    static String named(Class<?> c) { return mapped ? o2n.getOrDefault(c.getName(), c.getName()) : c.getName(); }
    static String simple(Object o) { return simpleOf(o.getClass()); }
    static String simpleOf(Class<?> c) {
        String n = named(c);
        n = n.substring(n.lastIndexOf('.') + 1);
        return n;
    }

    static Class<?> cls(String named) {
        try { return Class.forName(obfClass(named), true, loader); }
        catch (ClassNotFoundException e) { throw new RuntimeException("class not found: " + named, e); }
    }

    static Class<?> clsOrNull(String named) {
        try { return Class.forName(obfClass(named), true, loader); } catch (Throwable e) { return null; }
    }

    static boolean has(String named) { return clsOrNull(named) != null; }

    static Class<?> typeOf(String t) {
        int dims = 0;
        while (t.endsWith("[]")) { dims++; t = t.substring(0, t.length() - 2); }
        Class<?> c;
        switch (t) {
            case "int": c = int.class; break; case "long": c = long.class; break;
            case "float": c = float.class; break; case "double": c = double.class; break;
            case "boolean": c = boolean.class; break; case "byte": c = byte.class; break;
            case "short": c = short.class; break; case "char": c = char.class; break;
            case "void": c = void.class; break;
            default: c = cls(t);
        }
        for (int i = 0; i < dims; i++) c = Array.newInstance(c, 0).getClass();
        return c;
    }

    static List<Class<?>> hierarchy(Class<?> c) {
        LinkedHashSet<Class<?>> out = new LinkedHashSet<>();
        ArrayDeque<Class<?>> q = new ArrayDeque<>();
        q.add(c);
        while (!q.isEmpty()) {
            Class<?> k = q.poll();
            if (k == null || !out.add(k)) continue;
            if (k.getSuperclass() != null) q.add(k.getSuperclass());
            q.addAll(Arrays.asList(k.getInterfaces()));
        }
        return new ArrayList<>(out);
    }

    static boolean isMappedClass(Class<?> k) { return mapped && o2n.containsKey(k.getName()); }

    // ---- fields ----
    static final Map<String, Field> fcache = new HashMap<>();

    static Field field(Class<?> c, String name) {
        String key = c.getName() + "#" + name;
        if (fcache.containsKey(key)) return fcache.get(key);
        Field out = null;
        for (Class<?> k = c; k != null && out == null; k = k.getSuperclass()) {
            String real;
            if (isMappedClass(k)) {
                Map<String, String> fm = fields.get(named(k));
                real = fm == null ? null : fm.get(name);
            } else real = name;
            if (real == null) continue;
            try { Field f = k.getDeclaredField(real); f.setAccessible(true); out = f; }
            catch (NoSuchFieldException ignored) { }
            catch (Throwable t) { /* inaccessible JDK field */ }
        }
        fcache.put(key, out);
        return out;
    }

    static boolean hasField(Object o, String name) { return o != null && field(o.getClass(), name) != null; }

    static Object get(Object o, String name) {
        Field f = field(o.getClass(), name);
        if (f == null) throw new RuntimeException("no field " + name + " on " + named(o.getClass()));
        try { return f.get(o); } catch (IllegalAccessException e) { throw new RuntimeException(e); }
    }

    static Object getOr(Object o, String name, Object def) {
        Field f = o == null ? null : field(o.getClass(), name);
        if (f == null) return def;
        try { return f.get(o); } catch (IllegalAccessException e) { return def; }
    }

    static Object sget(String cls, String name) {
        Field f = field(cls(cls), name);
        if (f == null) throw new RuntimeException("no static field " + cls + "." + name);
        try { return f.get(null); } catch (IllegalAccessException e) { throw new RuntimeException(e); }
    }

    static Object sgetOrNull(String cls, String name) {
        Class<?> c = clsOrNull(cls);
        if (c == null) return null;
        Field f = field(c, name);
        if (f == null) return null;
        try { return f.get(null); } catch (IllegalAccessException e) { return null; }
    }

    // ---- methods ----
    static final Map<String, Method> mcache = new HashMap<>();

    static boolean compatible(Class<?>[] p, Object[] args) {
        if (p.length != args.length) return false;
        for (int i = 0; i < p.length; i++) {
            if (args[i] == null) { if (p[i].isPrimitive()) return false; continue; }
            if (!wrap(p[i]).isInstance(args[i])) return false;
        }
        return true;
    }

    static Class<?> wrap(Class<?> c) {
        if (!c.isPrimitive()) return c;
        if (c == int.class) return Integer.class;
        if (c == long.class) return Long.class;
        if (c == float.class) return Float.class;
        if (c == double.class) return Double.class;
        if (c == boolean.class) return Boolean.class;
        if (c == byte.class) return Byte.class;
        if (c == short.class) return Short.class;
        if (c == char.class) return Character.class;
        return Void.class;
    }

    static Method method(Class<?> c, String name, Object[] args) {
        StringBuilder key = new StringBuilder(c.getName()).append('#').append(name);
        for (Object a : args) key.append(',').append(a == null ? "null" : a.getClass().getName());
        String k = key.toString();
        if (mcache.containsKey(k)) return mcache.get(k);
        Method found = null;
        outer:
        for (Class<?> h : hierarchy(c)) {
            if (isMappedClass(h)) {
                List<String[]> ms = methods.get(named(h));
                if (ms == null) continue;
                for (String[] m : ms) {
                    if (!m[0].equals(name)) continue;
                    String[] ps = m[2].isEmpty() ? new String[0] : m[2].split(",");
                    if (ps.length != args.length) continue;
                    Class<?>[] pc = new Class<?>[ps.length];
                    try { for (int i = 0; i < ps.length; i++) pc[i] = typeOf(ps[i]); } catch (Throwable t) { continue; }
                    if (!compatible(pc, args)) continue;
                    try { found = h.getDeclaredMethod(m[1], pc); break outer; } catch (NoSuchMethodException ignored) { }
                }
            } else {
                for (Method m : h.getDeclaredMethods()) {
                    if (m.getName().equals(name) && !m.isBridge() && compatible(m.getParameterTypes(), args)) { found = m; break outer; }
                }
            }
        }
        if (found != null) {
            try { found.setAccessible(true); } catch (Throwable t) { /* public JDK method */ }
        }
        mcache.put(k, found);
        return found;
    }

    static boolean hasMethod(Object o, String name, Object... args) {
        return o != null && method(o.getClass(), name, args) != null;
    }

    static boolean hasStatic(String cls, String name, Object... args) {
        Class<?> c = clsOrNull(cls);
        return c != null && method(c, name, args) != null;
    }

    static Object call(Object o, String name, Object... args) {
        Method m = method(o.getClass(), name, args);
        if (m == null) throw new RuntimeException("no method " + name + "/" + args.length + " on " + named(o.getClass()));
        try { return m.invoke(o, args); }
        catch (InvocationTargetException e) { throw new RuntimeException(name + " threw " + e.getCause(), e.getCause()); }
        catch (IllegalAccessException e) { throw new RuntimeException(e); }
    }

    static Object scall(String cls, String name, Object... args) {
        Class<?> c = cls(cls);
        Method m = method(c, name, args);
        if (m == null) throw new RuntimeException("no static method " + cls + "." + name);
        try { return m.invoke(null, args); }
        catch (InvocationTargetException e) { throw new RuntimeException(name + " threw " + e.getCause(), e.getCause()); }
        catch (IllegalAccessException e) { throw new RuntimeException(e); }
    }

    /** Mojang name of a declared field. */
    static String fieldName(Field f) {
        if (!isMappedClass(f.getDeclaringClass())) return f.getName();
        Map<String, String> m = fieldsRev.get(named(f.getDeclaringClass()));
        String n = m == null ? null : m.get(f.getName());
        return n == null ? f.getName() : n;
    }

    static Object construct(String cls, Object... args) {
        Class<?> c = cls(cls);
        for (Constructor<?> k : c.getDeclaredConstructors()) {
            if (compatible(k.getParameterTypes(), args)) {
                try { k.setAccessible(true); return k.newInstance(args); }
                catch (InvocationTargetException e) { throw new RuntimeException("ctor threw " + e.getCause(), e.getCause()); }
                catch (ReflectiveOperationException e) { throw new RuntimeException(e); }
            }
        }
        throw new RuntimeException("no constructor for " + cls + "/" + args.length);
    }

    static final Object NONE = new Object();

    /** First of several method names that exists, or NONE. */
    static Object tryCall(Object o, String[] names, Object... args) {
        for (String n : names) if (hasMethod(o, n, args)) return call(o, n, args);
        return NONE;
    }
}
