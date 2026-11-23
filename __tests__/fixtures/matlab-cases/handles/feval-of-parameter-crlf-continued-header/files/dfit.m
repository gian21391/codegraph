function [m, p] ...
    = dfit(S, regr)
F = feval(regr, S);
m = F; p = 1;
end
