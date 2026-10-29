// For a binary without symbols: find functions that reference string
// literals matching a regex, decompile them plus their direct callees, and
// write everything to <outDir>/by-strings.c, ordered by address. Each function
// is prefixed with the matching strings it references, which act as names.
//
// headless args: <outDir> <stringRegex> [calleeDepth=1]
// @category ZaloLinux
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Reference;

import java.io.File;
import java.io.PrintWriter;
import java.util.*;
import java.util.regex.Pattern;

public class DumpByStrings extends GhidraScript {
    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        File outDir = new File(args[0]);
        outDir.mkdirs();
        Pattern rx = Pattern.compile(args[1]);
        int depth = args.length > 2 ? Integer.parseInt(args[2]) : 1;

        Map<Function, Set<String>> tags = new TreeMap<>(Comparator.comparing(Function::getEntryPoint));
        DataIterator it = currentProgram.getListing().getDefinedData(true);
        while (it.hasNext() && !monitor.isCancelled()) {
            Data d = it.next();
            StringDataInstance s = StringDataInstance.getStringDataInstance(d);
            if (s == StringDataInstance.NULL_INSTANCE) continue;
            String val = s.getStringValue();
            if (val == null || !rx.matcher(val).find()) continue;
            for (Reference r : getReferencesTo(d.getAddress())) {
                Function f = getFunctionContaining(r.getFromAddress());
                if (f != null) tags.computeIfAbsent(f, k -> new TreeSet<>()).add(val.replace("\n", "\\n"));
            }
        }

        Set<Function> all = new TreeSet<>(Comparator.comparing(Function::getEntryPoint));
        Set<Function> frontier = new HashSet<>(tags.keySet());
        all.addAll(frontier);
        for (int i = 0; i < depth; i++) {
            Set<Function> next = new HashSet<>();
            for (Function f : frontier) for (Function c : f.getCalledFunctions(monitor)) if (all.add(c)) next.add(c);
            frontier = next;
        }

        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);
        try (PrintWriter w = new PrintWriter(new File(outDir, "by-strings.c"), "UTF-8")) {
            for (Function f : all) {
                if (monitor.isCancelled()) break;
                if (f.isThunk() || f.isExternal()) continue;
                w.println("// " + f.getEntryPoint() + " " + f.getName(true) + " size=" + f.getBody().getNumAddresses());
                Set<String> t = tags.get(f);
                if (t != null) for (String s : t) w.println("//   str: " + s);
                DecompileResults r = ifc.decompileFunction(f, 60, monitor);
                w.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "/* decompile failed */");
            }
        }
        println("tagged " + tags.size() + " functions, dumped " + all.size());
    }
}
