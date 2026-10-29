// Decompile every non-thunk function whose entry lies in [start, end) and
// write them to <outDir>/range-<start>-<end>.c.
//
// headless args: <outDir> <startHex> <endHex>
// @category ZaloLinux
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;

import java.io.File;
import java.io.PrintWriter;

public class DumpRange extends GhidraScript {
    @Override
    protected void run() throws Exception {
        String[] a = getScriptArgs();
        File outDir = new File(a[0]);
        outDir.mkdirs();
        Address start = toAddr(a[1]), end = toAddr(a[2]);
        DecompInterface ifc = new DecompInterface();
        ifc.openProgram(currentProgram);
        int n = 0;
        try (PrintWriter w = new PrintWriter(new File(outDir, "range-" + a[1] + "-" + a[2] + ".c"), "UTF-8")) {
            for (Function f : currentProgram.getFunctionManager().getFunctions(start, true)) {
                if (f.getEntryPoint().compareTo(end) >= 0 || monitor.isCancelled()) break;
                if (f.isThunk()) continue;
                DecompileResults r = ifc.decompileFunction(f, 60, monitor);
                w.println("// " + f.getEntryPoint() + " " + f.getName() + " size=" + f.getBody().getNumAddresses());
                w.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "/* decompile failed */");
                n++;
            }
        }
        println("decompiled " + n);
    }
}
