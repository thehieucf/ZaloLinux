// Decompile the callers of the given functions, walking up `depth` levels,
// and write them to <outDir>/callers-<firstAddr>.c with the call tree.
//
// headless args: <outDir> <depth> <addr> [<addr> ...]
// @category ZaloLinux
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Reference;

import java.io.File;
import java.io.PrintWriter;
import java.util.*;

public class DumpCallers extends GhidraScript {
    // Thunks (incremental-link jumps) hide the real callers: look through them.
    private Set<Function> callersOf(Function f) {
        Set<Function> out = new LinkedHashSet<>();
        Deque<Function> todo = new ArrayDeque<>(List.of(f));
        Set<Function> seen = new HashSet<>();
        while (!todo.isEmpty()) {
            Function g = todo.pop();
            if (!seen.add(g)) continue;
            for (Reference r : getReferencesTo(g.getEntryPoint())) {
                Function c = getFunctionContaining(r.getFromAddress());
                if (c == null) continue;
                if (c.isThunk()) todo.push(c); else out.add(c);
            }
        }
        return out;
    }

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        File outDir = new File(args[0]);
        outDir.mkdirs();
        int depth = Integer.parseInt(args[1]);
        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);

        try (PrintWriter w = new PrintWriter(new File(outDir, "callers-" + args[2] + ".c"), "UTF-8")) {
            Set<Function> done = new HashSet<>();
            Deque<Object[]> todo = new ArrayDeque<>();
            for (int i = 2; i < args.length; i++) {
                Function f = getFunctionAt(toAddr(args[i]));
                if (f == null) f = getFunctionContaining(toAddr(args[i]));
                if (f != null) todo.add(new Object[]{f, 0, "root"});
            }
            while (!todo.isEmpty()) {
                Object[] it = todo.poll();
                Function f = (Function) it[0];
                int level = (Integer) it[1];
                if (!done.add(f)) continue;
                w.println("// ===== level " + level + " " + f.getEntryPoint() + " " + f.getName() + " (called-from-chain: " + it[2] + ")");
                DecompileResults r = ifc.decompileFunction(f, 90, monitor);
                w.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "/* decompile failed */");
                if (level < depth) for (Function c : callersOf(f)) todo.add(new Object[]{c, level + 1, f.getEntryPoint().toString()});
            }
        }
    }
}
