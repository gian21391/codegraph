classdef Bare
    methods
        function plot(obj)
        end
        function draw(obj, x)
            plot(x);
            plot(obj);
        end
    end
end
