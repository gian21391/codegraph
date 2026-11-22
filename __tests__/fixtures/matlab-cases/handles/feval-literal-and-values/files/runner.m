function runner(el, r, x, p)
feval('IdentStep', el, r);
m = 'DriftStep';
if x
    m = 'StepA';
end
r = feval(m, el, r);
m = 'LaterStep';
feval(p, r);
E.StepFcn = 'EStep';
feval(E.StepFcn, E, r);
for c = {'CellA', 'CellB'}
    feval(c{1}, r);
end
fh = @solve;
feval(fh, r);
feval('pkg.scale', r);
end
