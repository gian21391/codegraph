function evals(op, sel)
if sel
    eval('helperA(1)');
end
eval([op '(''setProc'')']);
eval('brokenB(', 'onErr(1)');
eval('eval(''innerB(1)'')');
x = evalc('quietC(2)');
end
