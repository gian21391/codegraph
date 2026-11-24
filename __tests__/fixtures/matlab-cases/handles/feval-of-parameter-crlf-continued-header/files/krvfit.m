function [m, p] ...
    = krvfit(S, basisf)
F = feval(basisf, S);
m = F; p = 1;
end
