// Decompile every function whose namespace path matches one of the given
// regexes and write them to <outDir>/<namespace>.c, plus an index of all
// functions (address, size, full name) to <outDir>/functions.tsv.
//
// headless args: <outDir> <regex> [<regex> ...]
// @category ZaloLinux
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;

import java.io.File;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;

public class DumpNamespaces extends GhidraScript {
    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        File outDir = new File(args[0]);
        outDir.mkdirs();
        List<Pattern> filters = new ArrayList<>();
        for (int i = 1; i < args.length; i++) filters.add(Pattern.compile(args[i]));

        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);

        Map<String, StringBuilder> byNamespace = new TreeMap<>();
        try (PrintWriter index = new PrintWriter(new File(outDir, "functions.tsv"), "UTF-8")) {
            for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
                String ns = f.getParentNamespace().getName(true);
                index.printf("%s\t%d\t%s%n", f.getEntryPoint(), f.getBody().getNumAddresses(), f.getName(true));
                boolean match = false;
                for (Pattern p : filters) if (p.matcher(ns).find()) { match = true; break; }
                if (!match || monitor.isCancelled()) continue;
                DecompileResults r = ifc.decompileFunction(f, 60, monitor);
                String c = r.decompileCompleted() ? r.getDecompiledFunction().getC() : "/* decompile failed: " + r.getErrorMessage() + " */\n";
                byNamespace.computeIfAbsent(ns, k -> new StringBuilder())
                        .append("// ").append(f.getEntryPoint()).append(" ").append(f.getName(true)).append("\n")
                        .append(c).append("\n");
            }
        }
        for (Map.Entry<String, StringBuilder> e : byNamespace.entrySet()) {
            String file = e.getKey().replaceAll("[^A-Za-z0-9_.-]+", "_") + ".c";
            try (PrintWriter w = new PrintWriter(new File(outDir, file), "UTF-8")) {
                w.print(e.getValue());
            }
        }
        println("dumped " + byNamespace.size() + " namespaces to " + outDir);
    }
}
